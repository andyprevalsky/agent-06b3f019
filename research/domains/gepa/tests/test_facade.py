"""Unit tests for the gepa domain facade modules (config, repo, service, types).

Each module is a thin re-export layer. We verify that every name in
``__all__`` resolves to an importable symbol and that the re-exported
callables produce the documented shapes when driven with fakes.
"""

from __future__ import annotations

import pytest


def _valid_planner_response():
    """Return a minimal valid 2-task PlannerResponse for scoring/validation tests."""
    from helpers.tool_schemas import DependencyEntry, PlannerResponse, PlannerTask

    return PlannerResponse(
        title='t',
        content='c',
        tasks=[
            PlannerTask(goal='a', tool_name='spawn_explore_agent', depends_on=[]),
            PlannerTask(goal='b', tool_name='spawn_explore_agent', depends_on=[0]),
        ],
        dependencies_graph=[
            DependencyEntry(task_idx='0', depends_on=[]),
            DependencyEntry(task_idx='1', depends_on=['0']),
        ],
        join='all',
    )


def test_package_docstring_present():
    import research.domains.gepa as pkg

    assert pkg.__doc__
    assert 'GEPA' in pkg.__doc__


def test_runtime_package_docstring():
    from research.domains.gepa import runtime

    assert runtime.__doc__


# -- config.py -------------------------------------------------------------


def test_config_exports_resolve():
    from research.domains.gepa import config

    for name in config.__all__:
        assert hasattr(config, name), f'missing re-export: {name}'


def test_config_derived_paths_have_expected_suffixes():
    from research.domains.gepa import config

    assert str(config.GEPA_LOG_DIR).endswith('gepa_logs_v3')
    assert str(config.PROGRESS_FILE).endswith('gepa_progress.json')
    assert str(config.OPTIMIZATION_RESULT_PATH).endswith('optimization_result.json')
    assert config.CRITIC_MODEL_ID == 'gepa_critic_312'
    assert config.MAX_CRITIC_RETRIES == 3
    assert config.CRITIC_RETRY_DELAY_S == 5


# -- repo.py ---------------------------------------------------------------


def test_repo_exports_resolve():
    from research.domains.gepa import repo

    for name in repo.__all__:
        assert hasattr(repo, name)


def test_load_trainset_delegates_to_underlying(monkeypatch):
    from research.domains.gepa import repo

    sentinel = object()
    captured = {}

    def fake_load(tasks_dir):
        captured['tasks_dir'] = tasks_dir
        return sentinel

    monkeypatch.setattr(repo, '_load_trainset', fake_load)
    result = repo.load_trainset(tasks_dir='/tmp/example')
    assert result is sentinel
    assert captured['tasks_dir'] == '/tmp/example'


def test_load_trainset_uses_default_tasks_dir(monkeypatch):
    from research.domains.gepa import repo

    captured = {}

    def fake_load(tasks_dir):
        captured['tasks_dir'] = tasks_dir
        return []

    monkeypatch.setattr(repo, '_load_trainset', fake_load)
    repo.load_trainset()
    assert captured['tasks_dir'] == repo.TASKS_DIR


# -- service.py ------------------------------------------------------------


def test_service_exports_resolve():
    from research.domains.gepa import service

    for name in service.__all__:
        assert hasattr(service, name), f'missing re-export: {name}'


def test_service_scoring_helpers_work():
    """The service layer re-exports scoring fns — sanity-check them end to end."""
    from research.domains.gepa.service import final_score, hard_gate, soft_penalties

    assert soft_penalties(me=True, ce=True, cx=True) == 0.0
    assert soft_penalties(me=False, ce=False, cx=False) > 0.0
    assert final_score(critic_score=0.4) == pytest.approx(0.4)
    assert hard_gate(_valid_planner_response()) == 0.0


def test_service_serialize_prompt_and_candidate():
    from research.domains.gepa.service import serialize_candidate, serialize_prompt

    prompt = serialize_prompt(
        'Find a flight',
        [{'role': 'user', 'content': 'hi'}, {'role': 'assistant', 'content': 'ok'}],
    )
    assert 'Find a flight' in prompt
    assert '[USER]: hi' in prompt

    cand = serialize_candidate(
        {
            'title': 'T',
            'content': 'C',
            'tasks': [{'goal': 'g', 'tool_name': 'x', 'depends_on': []}],
            'me': {'passed': True, 'score': 0.9, 'reasoning': 'r'},
            'ce': {'passed': False, 'score': 0.1, 'reasoning': 'r2'},
            'complexity': {'passed': True, 'score': 1.0, 'reasoning': 'r3'},
        }
    )
    assert 'Title: T' in cand
    assert 'ME: pass (0.90)' in cand
    assert 'CE: fail (0.10)' in cand


def test_service_cosine_similarity_and_retrieve():
    from research.domains.gepa.service import cosine_similarity, retrieve_similar_pairs

    assert cosine_similarity([1, 0], [1, 0]) == pytest.approx(1.0)
    assert cosine_similarity([1, 0], [0, 1]) == pytest.approx(0.0)
    assert cosine_similarity([0, 0], [1, 2]) == 0.0

    labels = [{'task_seed': 'a'}, {'task_seed': 'b'}, {'task_seed': 'c'}]
    embs = {'query': [1.0, 0.0], 'a': [0.9, 0.1], 'b': [0.0, 1.0], 'c': [0.5, 0.5]}
    result = retrieve_similar_pairs('query', labels, embs, n=2)
    assert len(result) == 2
    assert result[0]['task_seed'] == 'a'


def test_service_retrieve_similar_pairs_missing_query():
    """When the query text has no embedding, fall back to the first n labels."""
    from research.domains.gepa.service import retrieve_similar_pairs

    labels = [{'task_seed': 'a'}]
    result = retrieve_similar_pairs('missing', labels, {}, n=5)
    assert result == labels[:5]


def test_service_parse_plan():
    import json

    from research.domains.gepa.service import _parse_plan

    assert _parse_plan('{not json}') is None

    payload = {
        'title': 't',
        'content': 'c',
        'tasks': [{'goal': 'a', 'tool_name': 'x', 'depends_on': []}],
        'dependencies_graph': [{'task_idx': '0', 'depends_on': []}],
        'join': 'all',
    }
    pr = _parse_plan(json.dumps(payload))
    assert pr is not None
    assert pr.title == 't'


def test_service_retry_succeeds_immediately():
    from research.domains.gepa.service import _retry

    calls = []

    def fn():
        calls.append(1)
        return 'ok'

    assert _retry(fn, 'Label', max_retries=1) == 'ok'
    assert len(calls) == 1


def test_service_retry_raises_after_max_attempts(monkeypatch):
    import research.gepa.pipelines.gepa_optimizer as opt

    monkeypatch.setattr(opt, 'RETRY_DELAY_S', 0)

    from research.domains.gepa.service import _retry

    def always_fail():
        raise RuntimeError('boom')

    with pytest.raises(RuntimeError, match='failed after 2 attempts'):
        _retry(always_fail, 'L', max_retries=2)


def test_service_extract_strategy_and_compose():
    from research.domains.gepa.service import (
        compose_prompt,
        extract_strategy,
        get_initial_strategy,
    )

    initial = get_initial_strategy()
    assert 'TWO-AXIS PLANNING FRAMEWORK' in initial

    composed = compose_prompt('new-strategy')
    assert 'new-strategy' in composed
    assert 'AVAILABLE TOOLS' in composed

    with pytest.raises(ValueError):
        extract_strategy('totally unrelated text')


def test_service_build_prompt_skeleton_strips_strategy():
    from research.domains.gepa.service import _build_prompt_skeleton

    sk = _build_prompt_skeleton()
    assert 'TWO-AXIS PLANNING FRAMEWORK' not in sk
    assert 'AVAILABLE TOOLS' in sk


def test_service_make_decomposer_module():
    from research.domains.gepa.service import _make_decomposer_module

    module = _make_decomposer_module()
    assert module is not None
    assert hasattr(module, 'planner')


def test_service_validate_decomposition_via_service():
    from research.domains.gepa.service import validate_decomposition

    assert validate_decomposition(_valid_planner_response()) == []


def test_service_make_gepa_metric_returns_callable():
    from research.domains.gepa.service import make_gepa_metric

    metric = make_gepa_metric(critic_model_id='stub')
    assert callable(metric)


def test_service_optimize_prompt_requires_api_key(monkeypatch):
    monkeypatch.delenv('OPENROUTER_API_KEY', raising=False)

    from research.domains.gepa.service import optimize_prompt

    with pytest.raises(ValueError, match='OPENROUTER_API_KEY'):
        optimize_prompt(auto='light', openrouter_api_key=None)


def test_service_optimize_prompt_delegates(monkeypatch):
    """optimize_prompt wires together trainset + metric + GEPA.compile."""
    from research.domains.gepa.service import optimize_prompt

    monkeypatch.setenv('OPENROUTER_API_KEY', 'stub')

    trainset = [object(), object()]
    result = optimize_prompt(auto='light', trainset=trainset)
    assert result.optimized_strategy == 'stub-strategy'
    assert 'stub-strategy' in result.optimized_prompt
    assert result.demos == []


def test_service_optimize_prompt_empty_trainset_raises(monkeypatch, tmp_path):
    from research.domains.gepa.service import optimize_prompt

    monkeypatch.setenv('OPENROUTER_API_KEY', 'stub')

    with pytest.raises(ValueError, match='No training examples'):
        optimize_prompt(auto='light', trainset=[], tasks_dir=tmp_path)


# -- types.py --------------------------------------------------------------


def test_types_exports_resolve():
    from research.domains.gepa import types as domain_types

    for name in domain_types.__all__:
        assert hasattr(domain_types, name)


def test_optimization_result_dataclass_defaults():
    from research.domains.gepa.types import OptimizationResult

    result = OptimizationResult(
        optimized_strategy='s',
        optimized_prompt='p',
        initial_score=0.0,
        final_score=0.5,
        num_trials=7,
    )
    assert result.demos == []
    assert result.final_score == 0.5


def test_evaluation_result_passthrough():
    from research.domains.gepa.types import EvalResult, ValidationError

    e = EvalResult(passed=True, score=1.0, reasoning='ok')
    assert e.passed and e.score == 1.0
    v = ValidationError('CYCLE_DETECTED', 'cycle')
    assert v.type == 'CYCLE_DETECTED'
