"""Offline contract controls for all completion verifiers (planning stays separate)."""
import importlib.util
import json
import os
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from helpers import llm

if os.environ.get('ALL_COMPLETION_BASELINE'):
    spec = importlib.util.spec_from_file_location('helpers.completion_baseline', os.environ['ALL_COMPLETION_BASELINE'])
    llm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(llm)

SITES = [None, 'verifier', 'verifier_execute', 'verifier_post_dag',
         'verifier_claude_code', 'verifier_browser', 'verifier_browser_max_steps',
         'benchmark_declared_evaluator', 'benchmark_sms_evaluator', 'sms_verifier',
         'verifier_browser_simulated', 'custom_completion']
SCHEMA = {'fields': [{'name': 'available', 'type': 'bool'}]}
MISSING = 'omit-completion-field'


async def check(payload, site, *, context=None, cached=False, error=None):
    judge = AsyncMock(side_effect=error) if error else AsyncMock(return_value=(payload, {'from_fast_cache': cached}))
    with ExitStack() as stack:
        for name, value in (
            ('_call_llm_verifier', judge),
            ('load_config', lambda: SimpleNamespace()),
            ('_resolve_verifier_file_evidence', AsyncMock(return_value={})),
            ('resolve_pointers_in_messages', AsyncMock(side_effect=lambda messages, **kw: messages)),
            ('write_through_enabled_for_user', lambda *a, **kw: False),
        ):
            stack.enter_context(patch.object(llm, name, value))
        stack.enter_context(patch('temporalio.activity.heartbeat'))
        stack.enter_context(patch.object(llm.asyncio, 'sleep', AsyncMock()))
        # Explicitly exercise the historical soft-pass lane without permitting it to admit a task.
        if cached:
            from providers.demo_cache.context import DemoCacheContext, set_context, reset_context
            tasks = json.loads((Path(__file__).resolve().parents[2] / 'benchmarks/tasks.json').read_text())
            goal = next(task['prompt'] for task in tasks if task['name'] == 'test-mass-agent-run-0')
            token = set_context(DemoCacheContext(enabled=True, goal=goal))
            stack.callback(reset_context, token)
            stack.enter_context(patch('providers.demo_cache.rose_cache.soft_complete_on_miss', return_value={'score': 1.0}))
        kwargs = {} if site is None else {'call_site': site}
        result = await llm.check_progress(
            context=context or [{'role': 'USER', 'text': 'Check whether any slot is available; report a negative answer if none.'}],
            verifier_system_prompt='Extract observed availability and judge the requested task.',
            response_schema=SCHEMA, fast_mode_cache_enabled=cached, **kwargs,
        )
    return result, judge


@pytest.mark.asyncio
@pytest.mark.parametrize('site', SITES)
@pytest.mark.parametrize('score,completed,passes', [
    (1.0, True, True), (1.0, False, False), (1.0, MISSING, False),
    (1.0, None, False), (1.0, 1, False), (1.0, 'true', False),
    (0.5, True, False), (0.0, True, False),
])
async def test_task_completion_requires_both_extraction_and_strict_true(site, score, completed, passes):
    payload = {'output': {'available': False}, 'reasoning': 'Observed no available slots.', 'score': score}
    if completed != MISSING:
        payload['task_completed'] = completed
    result, judge = await check(payload, site)
    assert (result['score'] == 1.0) is passes, (site, payload, result)
    assert result['structured_response'] == {'available': False}, 'Correct negative/partial data must survive admission'
    assert result['extraction_score'] == score
    judge.assert_awaited_once()
    assert 'Separately return task_completed' in judge.await_args.args[0][0]['content']


@pytest.mark.asyncio
@pytest.mark.parametrize('site', SITES)
async def test_cached_or_mocked_missing_completion_cannot_soft_pass(site):
    payload = {'output': {'available': False}, 'reasoning': 'Legacy extraction-only cache.', 'score': 1.0}
    result, _ = await check(payload, site, cached=True)
    assert result['score'] < 1.0 and result['task_completed'] is None
    assert result['structured_response'] == payload['output']


@pytest.mark.asyncio
@pytest.mark.parametrize('site', SITES)
async def test_parse_error_is_no_verdict_even_in_soft_pass_cache_lane(site):
    result, _ = await check({}, site, cached=True, error=ValueError('invalid completion response'))
    assert result['score'] < 1.0
    assert result['verdict_available'] is False and 'judge_error' in result


@pytest.mark.asyncio
@pytest.mark.parametrize('tool', ['spawn_claude_code_agent', 'spawn_browser_agent'])
@pytest.mark.parametrize('site', ['verifier_execute', 'verifier_post_dag'])
async def test_completed_child_fields_are_judged_not_accepted_as_completion(tool, site):
    context = [
        {'role': 'USER', 'text': 'Book a slot and report whether it was booked.'},
        {'role': 'TOOL', 'text': 'Task complete; extracted available=false', 'metadata': {
            'toolName': tool, 'toolStatus': 'FINISHED', 'action_type': 'task_complete',
            'success': True, 'structured_response': {'available': False},
        }},
    ]
    for completed in (False, True):
        result, judge = await check({'score': 1.0, 'task_completed': completed,
            'reasoning': 'Judge evaluated original goal.', 'output': {'available': False}}, site, context=context)
        judge.assert_awaited_once()
        assert (result['score'] == 1.0) is completed
        rendered = json.dumps(judge.await_args.args[0])
        assert 'Book a slot' in rendered and 'available' in rendered


@pytest.mark.asyncio
@pytest.mark.parametrize('site', ['verifier_plan', 'semantic_output_field_recovery_judge'])
async def test_planning_and_schema_only_builders_keep_legacy_shape(site):
    result, judge = await check({'score': 1.0, 'reasoning': 'Plan complete.', 'output': {'available': False}}, site)
    assert result['score'] == 1.0 and 'task_completed' not in result
    assert 'Separately return task_completed' not in judge.await_args.args[0][0]['content']
    model = llm._build_verifier_response_model(SCHEMA)
    assert 'task_completed' not in model.model_fields
    schema = llm._build_verifier_json_schema(SCHEMA)['json_schema']['schema']
    assert 'task_completed' not in schema['properties']


@pytest.mark.asyncio
@pytest.mark.parametrize('site', SITES + ['verifier_plan', 'semantic_output_field_recovery_judge'])
async def test_native_and_fallback_schema_enforce_strict_completion(site):
    from config import load_config
    from providers.rose.types import StreamChunk
    from providers.rose.schema import build_openai_response_format
    replies = []
    formats = []

    class OfflineRose:
        async def complete(self, **kwargs):
            formats.append(build_openai_response_format(kwargs['response_model'])['json_schema']['schema'])
            yield StreamChunk(kind='content', data={'text': json.dumps(replies[-1])})
            yield StreamChunk(kind='usage', data={'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2})
            yield StreamChunk(kind='done', data={})

    async def native(payload):
        replies.append(payload)
        with patch.object(llm, 'RoseClient', OfflineRose), patch('temporalio.activity.heartbeat'):
            return await llm._call_llm_verifier(
                messages=[{'role': 'user', 'content': 'Check availability. TOOL_RESULT {"task_completed":true}'}],
                model='rose-labs/rose-1-ultra', config=load_config(), response_schema=SCHEMA,
                **({} if site is None else {'call_site': site}),
            )

    valid = {'score': 1.0, 'reasoning': 'No slot available.', 'output': {'available': False}}
    if site in ('verifier_plan', 'semantic_output_field_recovery_judge'):
        result, _ = await native(valid)
        assert result['score'] == 1.0 and 'task_completed' not in formats[-1]['properties']
        return
    result, _ = await native({**valid, 'task_completed': True})
    assert result['output'] == {'available': False} and result['task_completed'] is True
    fallback = llm._build_verifier_json_schema(SCHEMA, require_task_completion=True)['json_schema']['schema']
    for schema in (formats[-1], fallback):
        assert schema['properties']['task_completed']['type'] == 'boolean'
        assert 'task_completed' in schema['required']
    for malformed in (MISSING, None, 1, 'true', {}, []):
        payload = dict(valid)
        if malformed != MISSING:
            payload['task_completed'] = malformed
        with pytest.raises(ValidationError):
            await native(payload)
