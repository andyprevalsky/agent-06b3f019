"""Polar results are judged by requested outcome, not retrieval tooling."""
import ast
import copy
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from benchmarks import run_benchmark as runner
from benchmarks.benchmark_tasks import _load_tasks, get_task_by_name
from benchmarks.polar_catalog import build_polar_catalog_tasks, load_polar_tasks_file

ROOT = Path(__file__).resolve().parents[2]

@pytest.mark.asyncio
@pytest.mark.parametrize("correct", [True, False])
@pytest.mark.parametrize("progress", [0.0, 1.0])
async def test_no_browser_polar_uses_semantic_outcome(monkeypatch, correct, progress):
    task = copy.deepcopy(get_task_by_name('polar-bu-071'))
    data = {'agent': {'status': 'COMPLETED', 'progress': progress}, 'messages': [
        {'role': 'TOOL', 'text': 'Read source using ordinary research tooling',
         'metadata': {'toolName': 'web_fetch', 'toolStatus': 'FINISHED'}},
        {'role': 'ASSISTANT', 'text': '4' if correct else '19', 'metadata': {}},
    ]}
    from benchmarks import polar_evaluator
    judge = AsyncMock(return_value={'score': 1.0 if correct else 0.0,
        'reasoning': 'Requested answer matches evidence' if correct else 'Wrong requested answer'})
    monkeypatch.setattr(polar_evaluator, 'run_polar_evaluator', judge)
    admitted, reason = runner.evaluate_task(task, data, 0)
    assert admitted, reason
    passed, reason, results = await runner._run_declared_evaluators(task, data)
    assert passed is correct
    assert results[0]['passed'] is correct
    judge.assert_awaited_once()
    assert judge.await_args.kwargs['task_prompt'] == task.prompt
    assert all(m.get('metadata', {}).get('toolName') != 'spawn_browser_agent' for m in data['messages'])

@pytest.mark.asyncio
async def test_create_preserves_generic_explicit_phase(monkeypatch):
    import httpx
    sent = []
    def respond(request):
        import json
        if request.method == 'POST':
            sent.append(json.loads(request.content))
            return httpx.Response(201, json={'agent_id': 'offline-test'})
        return httpx.Response(200, json={'agent': {'write_lock_enabled': False}})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda *a, **kw: real_client(transport=httpx.MockTransport(respond)))
    monkeypatch.setattr(runner, '_api_headers', AsyncMock(return_value={}))
    monkeypatch.setattr(runner, '_local_benchmark_task_queue', lambda *a, **kw: None)
    monkeypatch.setattr(runner, '_frontend_url_for_benchmark', lambda *a, **k: 'http://localhost:3002')
    task = copy.deepcopy(get_task_by_name('polar-bu-071'))
    await runner.create_agent('http://localhost:3001', task)
    assert sent[-1]['start_phase'] == 'execute'
    assert sent[-1]['goal'] == task.prompt
    ordinary = copy.deepcopy(get_task_by_name('browser-smoke'))
    ordinary.start_phase = 'plan'
    await runner.create_agent('http://localhost:3001', ordinary)
    assert sent[-1]['start_phase'] == 'plan'


def test_all_polar_catalog_rows_are_outcome_scoped():
    raw = load_polar_tasks_file()
    assert raw == build_polar_catalog_tasks()
    for task in _load_tasks():
        if task.group != 'polar-bench':
            continue
        assert task.expected_tools == []
        assert task.requires_browser_agent is False
        assert not task.min_tool_counts and not task.expected_tool_counts and not task.forbidden_tools
        assert task.min_steps == {}
        assert task.start_phase == 'execute'
        assert task.enforce_declared_evaluators
        assert all(e['method'] == 'polar' for e in task.evaluators)


def test_nonpolar_tool_and_step_guards_and_genuine_failures_remain():
    ordinary = copy.deepcopy(get_task_by_name('browser-smoke'))
    assert ordinary.min_steps == {'browser': 1}
    assert runner._validate_agent_class_min_steps(ordinary.min_steps, {})
    assert runner._validate_tool_count_expectations({}, {'spawn_browser_agent': 1}, [])
    admitted, reason = runner.evaluate_task(ordinary, {'agent': {'status': 'COMPLETED', 'progress': 1}, 'messages': []}, 0)
    assert not admitted and 'tool' in reason.lower()
    polar = copy.deepcopy(get_task_by_name('polar-bu-071'))
    admitted, reason = runner.evaluate_task(polar, {'agent': {'status': 'FAILED', 'progress': 1}, 'messages': []}, 0)
    assert not admitted and 'FAILED' in reason


def test_production_workflow_has_no_browser_only_execution_route():
    source = (ROOT/'agents/workflows/agent_workflow.py').read_text()
    tree = ast.parse(source)
    assert not any(isinstance(n, ast.ImportFrom) and n.module == 'workflows.browser_execution' for n in ast.walk(tree))
    assert '_browser_execution_mode' not in source
    assert 'browser_finalizer_ready' not in source and 'stop_at_browser_budget' not in source
    # Completion revision and presentation protections remain active.
    assert 'async def _finish_verified_completion' in source
    assert 'class CompletionSupersededError' in source
    assert 'require_current_final_presentation()' in source
    assert not (ROOT/'agents/workflows/browser_execution.py').exists()


@pytest.mark.asyncio
async def test_nonbrowser_tool_tree_evidence_reaches_actual_judge(monkeypatch):
    from benchmarks import polar_evaluator as pe
    task = copy.deepcopy(get_task_by_name('polar-bu-071'))
    data = {'agent': {'status': 'COMPLETED', 'progress': 1}, 'messages': [
        {'role': 'TOOL', 'metadata': {'toolName': 'web_fetch', 'toolStatus': 'FINISHED',
                                    'structured_response': {'access_day': 4, 'source': 'book endnote'}}},
        {'role': 'ASSISTANT', 'text': '4', 'metadata': {}},
    ], '_semantic_evaluator_tree': {'child': {'messages': [
        {'role': 'TOOL', 'message': 'Verified endnote by local PDF extraction',
         'metadata': {'toolName': 'spawn_claude_code_agent', 'toolStatus': 'FINISHED'}}
    ]}}}
    seen = []
    async def judge(messages, **kwargs):
        text = str(messages)
        seen.append(text)
        assert 'book endnote' in text and 'access_day' in text
        assert 'Verified endnote by local PDF extraction' in text
        assert task.prompt in text
        return 'Status: success'
    monkeypatch.setattr(pe, '_default_judge_llm', judge)
    passed, reason, results = await runner._run_declared_evaluators(task, data)
    assert passed, reason
    assert len(seen) == len(task.evaluators[0]['rubrics'])
    assert all(r['passed'] for r in results)
