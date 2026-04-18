"""Unit tests for the gepa runtime entry points.

Each runtime module has a ``main()`` that wires the domain's service layer
to an external optimiser (DSPy GEPA, modal critic, LLM judge).  The tests
below exercise every branch through extensive mocking so they finish in
milliseconds with no live dependencies.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from typing import ClassVar
from unittest.mock import MagicMock

import pytest


def _install_fake_benchmark(
    monkeypatch, me: float = 1.0, ce: float = 1.0, cx: float = 1.0, *, raises: bool = False
):
    """Register a fake ``research.gepa.pipelines.benchmark`` module for a test.

    Returns the installed module. When ``raises`` is True the evaluators raise
    RuntimeError on every call (used to exercise retry/failure paths).
    """
    fake_bench = types.ModuleType('research.gepa.pipelines.benchmark')

    async def _make(score):
        return types.SimpleNamespace(score=score), {}

    async def _me(goal, pr, ctx):
        if raises:
            raise RuntimeError('nope')
        return await _make(me)

    async def _ce(goal, pr, ctx):
        if raises:
            raise RuntimeError('nope')
        return await _make(ce)

    async def _cx(goal, pr, ctx):
        if raises:
            raise RuntimeError('nope')
        return await _make(cx)

    fake_bench._eval_me = _me
    fake_bench._eval_ce = _ce
    fake_bench._eval_cx = _cx
    monkeypatch.setitem(sys.modules, 'research.gepa.pipelines.benchmark', fake_bench)
    return fake_bench


# --- runtime/run.py -------------------------------------------------------


def test_run_main_without_test_mode(monkeypatch, caplog):
    import research.domains.gepa.runtime.run as run_mod

    monkeypatch.setattr(sys, 'argv', ['run.py'])
    with caplog.at_level('INFO'):
        run_mod.main()
    assert any('--test-mode' in r.message for r in caplog.records)


def test_run_main_test_mode_invokes_optimize(monkeypatch):
    import research.domains.gepa.runtime.run as run_mod

    called = {}

    class FakeResult:
        initial_score = 0.1
        final_score = 0.9
        num_trials = 4

    def fake_optimize(**kwargs):
        called.update(kwargs)
        return FakeResult()

    monkeypatch.setattr(run_mod, 'optimize_prompt', fake_optimize)
    monkeypatch.setattr(sys, 'argv', ['run.py', '--test-mode'])
    run_mod.main()
    assert called == {'auto': 'light', 'num_threads': 2}


# --- runtime/judge.py -----------------------------------------------------


def test_judge_main_invokes_judge_all_tasks(monkeypatch):
    import research.domains.gepa.runtime.judge as judge_mod

    async def fake_judge_all_tasks():
        return [
            {'preference': 'A'},
            {'preference': 'B'},
            {'preference': 'A'},
            {'preference': 'SKIP'},
        ]

    fake_sp = types.ModuleType('research.gepa.pipelines.synthetic_pairs')
    fake_sp.judge_all_tasks = fake_judge_all_tasks
    monkeypatch.setitem(sys.modules, 'research.gepa.pipelines.synthetic_pairs', fake_sp)

    asyncio.run(judge_mod.main())


# --- runtime/smoke.py -----------------------------------------------------


def test_smoke_train_requires_enough_pairs(monkeypatch):
    import research.domains.gepa.runtime.smoke as smoke_mod

    monkeypatch.setattr(smoke_mod, 'prepare_reward_pairs', None, raising=False)

    import research.domains.gepa.repo as repo

    def fake_prepare_reward_pairs():
        return {'prompt': ['a'], 'chosen': ['b'], 'rejected': ['c']}

    monkeypatch.setattr(repo, 'prepare_reward_pairs', fake_prepare_reward_pairs)

    with pytest.raises(SystemExit):
        smoke_mod._train_smoke_reward_model()


def test_smoke_train_success(monkeypatch):
    import research.domains.gepa.repo as repo
    import research.domains.gepa.runtime.smoke as smoke_mod
    import research.domains.gepa.service as service

    pairs = {
        'prompt': [f'p{i}' for i in range(6)],
        'chosen': [f'c{i}' for i in range(6)],
        'rejected': [f'r{i}' for i in range(6)],
    }
    monkeypatch.setattr(repo, 'prepare_reward_pairs', lambda: pairs)
    monkeypatch.setattr(
        service,
        'train_reward_model',
        lambda rows, base_model, model_id: {'model_id': model_id, 'train_loss': 0.2},
    )

    smoke_mod._train_smoke_reward_model()


def test_smoke_run_optimization(monkeypatch):
    import research.domains.gepa.repo as repo
    import research.domains.gepa.runtime.smoke as smoke_mod
    import research.domains.gepa.service as service

    class Ex:
        def __init__(self, g):
            self.goal = g

    trainset = [Ex(f'task-{i}') for i in range(10)]
    monkeypatch.setattr(repo, 'load_trainset', lambda tasks_dir=None: trainset)

    class FakeResult:
        optimized_strategy = 'OPT'
        optimized_prompt = 'prompt'
        demos: ClassVar[list] = []

    monkeypatch.setattr(service, 'optimize_prompt', lambda **kwargs: FakeResult())
    monkeypatch.setattr(service, 'get_initial_strategy', lambda: 'INITIAL')
    module = MagicMock(planner=MagicMock(signature=MagicMock(instructions='abc')))
    monkeypatch.setattr(service, '_make_decomposer_module', lambda: module)

    result = smoke_mod._run_smoke_optimization()
    assert result.optimized_strategy == 'OPT'


def test_smoke_report_asserts_required_sections(caplog):
    import research.domains.gepa.runtime.smoke as smoke_mod

    class Good:
        optimized_strategy = 'strategy'
        optimized_prompt = 'OUTPUT CONTRACT\nAVAILABLE TOOLS\nSPAWN_SUB_AGENT TOOL'
        demos: ClassVar[list] = [1, 2]

    with caplog.at_level('INFO'):
        smoke_mod._report(Good())
    assert any('SMOKE TEST PASSED' in r.message for r in caplog.records)


def test_smoke_report_missing_section_fails():
    import research.domains.gepa.runtime.smoke as smoke_mod

    class Bad:
        optimized_strategy = 's'
        optimized_prompt = 'nothing relevant'
        demos: ClassVar[list] = []

    with pytest.raises(AssertionError, match='OUTPUT CONTRACT'):
        smoke_mod._report(Bad())


def test_smoke_main(monkeypatch):
    import research.domains.gepa.runtime.smoke as smoke_mod

    monkeypatch.setattr(smoke_mod, '_train_smoke_reward_model', lambda: None)

    class Good:
        optimized_strategy = 's'
        optimized_prompt = 'OUTPUT CONTRACT\nAVAILABLE TOOLS\nSPAWN_SUB_AGENT TOOL'
        demos: ClassVar[list] = []

    monkeypatch.setattr(smoke_mod, '_run_smoke_optimization', lambda: Good())
    smoke_mod.main()


# --- runtime/run_full_pipeline.py -----------------------------------------


def test_run_full_pipeline_strip_code_fences():
    import research.domains.gepa.runtime.run_full_pipeline as rfp

    assert rfp._strip_code_fences('plain text') == 'plain text'
    fenced = '```json\n{"a":1}\n```'
    assert rfp._strip_code_fences(fenced) == '{"a":1}'


def test_run_full_pipeline_patch_dspy_reasoning():
    from dspy.clients.base_lm import BaseLM

    import research.domains.gepa.runtime.run_full_pipeline as rfp

    original_process_completion = BaseLM._process_completion
    try:
        rfp._patch_dspy_reasoning()

        # With reasoning_content but no text → pick up reasoning_content
        out = BaseLM()._process_completion(None, {})
        # _process_completion returns list[{'text': 'ok'}] from the stub; after patch
        # the single-dict collapse rule applies → list of strings
        assert out == ['ok'] or (isinstance(out, list) and 'ok' in out[0].get('text', ''))
    finally:
        BaseLM._process_completion = original_process_completion


def test_run_full_pipeline_patch_lm_logging(caplog):
    from dspy.clients.base_lm import BaseLM

    import research.domains.gepa.runtime.run_full_pipeline as rfp

    original_call = BaseLM.__call__
    try:
        rfp._patch_lm_logging()
        with caplog.at_level('INFO'):
            BaseLM()(prompt=None, messages=[{'content': 'hi'}])
        assert any('[LM #' in r.message for r in caplog.records)
    finally:
        BaseLM.__call__ = original_call


def test_run_full_pipeline_patch_lm_logging_records_errors(caplog):
    from dspy.clients.base_lm import BaseLM

    import research.domains.gepa.runtime.run_full_pipeline as rfp

    def boom(self, prompt=None, messages=None, **kwargs):
        raise ValueError('bad')

    original = BaseLM.__call__
    BaseLM.__call__ = boom
    try:
        rfp._patch_lm_logging()
        with caplog.at_level('INFO'), pytest.raises(ValueError):
            BaseLM()(messages=[{'content': 'x'}])
        assert any('ERR' in r.message for r in caplog.records)
    finally:
        BaseLM.__call__ = original


def test_run_full_pipeline_configure_rose_ultra_lm(monkeypatch):
    import research.domains.gepa.runtime.run_full_pipeline as rfp

    monkeypatch.setenv('ROSE_API_KEY', 'key')
    monkeypatch.setenv('SUPABASE_ANON_KEY', 'anon')
    monkeypatch.setenv('ROSE_API_URL', 'https://example.com')

    lm = rfp._configure_rose_ultra_lm()
    assert lm is not None


def test_run_full_pipeline_run_evaluators_success(monkeypatch):
    import research.domains.gepa.runtime.run_full_pipeline as rfp

    _install_fake_benchmark(monkeypatch, me=0.9, ce=0.8, cx=0.7)
    me, ce, cx = asyncio.run(rfp._run_evaluators('goal', None, {}))
    assert me == 0.9 and ce == 0.8 and cx == 0.7


def test_run_full_pipeline_run_evaluators_retries_then_raises(monkeypatch):
    import research.domains.gepa.runtime.run_full_pipeline as rfp

    monkeypatch.setattr(rfp, 'CRITIC_RETRY_DELAY_S', 0)
    monkeypatch.setattr(rfp, 'MAX_CRITIC_RETRIES', 2)
    _install_fake_benchmark(monkeypatch, raises=True)

    with pytest.raises(RuntimeError, match='failed after'):
        asyncio.run(rfp._run_evaluators('g', None, {}))


def test_run_full_pipeline_build_metric_parse_fail(monkeypatch):
    import research.domains.gepa.runtime.run_full_pipeline as rfp

    call_n = [0]
    metric = rfp._build_metric(call_n)

    pred = types.SimpleNamespace(plan_json='not-json')
    example = types.SimpleNamespace(goal='g', context='{}')
    out = metric(example, pred)
    assert out.score == 0.0
    assert 'Could not parse' in out.feedback


def test_run_full_pipeline_build_metric_gate_fail(monkeypatch):
    import research.domains.gepa.runtime.run_full_pipeline as rfp

    call_n = [0]
    metric = rfp._build_metric(call_n)

    # Single-task response fails hard_gate (MIN_TASKS=2)
    plan = {
        'title': 't',
        'content': 'c',
        'tasks': [{'goal': 'only', 'tool_name': 'spawn_explore_agent', 'depends_on': []}],
        'dependencies_graph': [{'task_idx': '0', 'depends_on': []}],
        'join': 'all',
    }
    pred = types.SimpleNamespace(plan_json=json.dumps(plan))
    example = types.SimpleNamespace(goal='g', context='{}')
    out = metric(example, pred)
    assert out.score == 0.0
    assert 'Invalid structure' in out.feedback


def test_run_full_pipeline_build_metric_happy_path(monkeypatch):
    import research.domains.gepa.runtime.run_full_pipeline as rfp
    import research.domains.gepa.service as service

    monkeypatch.setattr(service, 'score_candidates', lambda *a, **k: [0.0])
    _install_fake_benchmark(monkeypatch)

    call_n = [0]
    metric = rfp._build_metric(call_n)

    plan = {
        'title': 't',
        'content': 'c',
        'tasks': [
            {'goal': 'a', 'tool_name': 'spawn_explore_agent', 'depends_on': []},
            {'goal': 'b', 'tool_name': 'spawn_explore_agent', 'depends_on': [0]},
        ],
        'dependencies_graph': [
            {'task_idx': '0', 'depends_on': []},
            {'task_idx': '1', 'depends_on': ['0']},
        ],
        'join': 'all',
    }
    pred = types.SimpleNamespace(plan_json='```json\n' + json.dumps(plan) + '\n```')
    example = types.SimpleNamespace(goal='g', context=[{'role': 'user', 'content': 'x'}])
    out = metric(example, pred)
    assert 0.0 <= out.score <= 1.0
    assert 'critic=' in out.feedback
    assert call_n[0] == 1


def test_run_full_pipeline_progress_reporter_writes_json(tmp_path, monkeypatch):
    import threading
    import time

    import research.domains.gepa.runtime.run_full_pipeline as rfp

    # First Event.wait() call returns False (do one loop iteration), subsequent
    # calls return True (stop the loop) so the helper thread writes exactly once.
    def short_wait(self, timeout=None):
        if not getattr(self, '_flag', False):
            self._flag = True
            return False
        return True

    monkeypatch.setattr(threading.Event, 'wait', short_wait)

    progress_file = tmp_path / 'progress.json'
    call_n = [5]
    stop = rfp._start_progress_reporter(progress_file, call_n, time.time() - 120)
    for _ in range(100):
        if progress_file.exists():
            break
        time.sleep(0.01)
    stop.set()

    assert progress_file.exists(), 'progress reporter thread never wrote the file'
    payload = json.loads(progress_file.read_text())
    assert payload['metric_calls'] == 5
    assert payload['status'] == 'running'


def test_run_full_pipeline_write_optimization_result(tmp_path, monkeypatch):
    import research.domains.gepa.runtime.run_full_pipeline as rfp

    out_path = tmp_path / 'out.json'
    call_n = [3]
    demos = [1, 2]
    rfp._write_optimization_result(out_path, 'OPT-STRAT', 12.3, call_n, demos)
    payload = json.loads(out_path.read_text())
    assert payload['optimized_strategy'] == 'OPT-STRAT'
    assert payload['elapsed_s'] == 12.3
    assert payload['demos'] == 2


def test_run_full_pipeline_main(monkeypatch, tmp_path):
    import research.domains.gepa.repo as repo
    import research.domains.gepa.runtime.run_full_pipeline as rfp
    import research.domains.gepa.service as service

    monkeypatch.setattr(rfp, '_patch_dspy_reasoning', lambda: None)
    monkeypatch.setattr(rfp, '_patch_lm_logging', lambda: None)

    class FakeLM:
        pass

    monkeypatch.setattr(rfp, '_configure_rose_ultra_lm', lambda: FakeLM())
    monkeypatch.setattr(rfp, '_build_metric', lambda call_n: lambda *a, **k: None)
    monkeypatch.setattr(repo, 'load_trainset', lambda tasks_dir: ['ex1', 'ex2'])

    class FakeModule:
        planner = types.SimpleNamespace(
            signature=types.SimpleNamespace(instructions='strat-out'),
            demos=[],
        )

    monkeypatch.setattr(service, '_make_decomposer_module', lambda: FakeModule())

    class FakeOptimizer:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def compile(self, module, trainset):
            return module

    import dspy

    monkeypatch.setattr(dspy, 'GEPA', FakeOptimizer)

    stop_event = MagicMock()
    monkeypatch.setattr(rfp, '_start_progress_reporter', lambda *a, **k: stop_event)

    monkeypatch.setattr(rfp, 'PROGRESS_FILE', tmp_path / 'progress.json')
    monkeypatch.setattr(rfp, 'GEPA_LOG_DIR', tmp_path / 'logs')
    monkeypatch.setattr(rfp, 'OPTIMIZATION_RESULT_PATH', tmp_path / 'out.json')

    rfp.main()
    assert (tmp_path / 'out.json').exists()
    stop_event.set.assert_called_once()
