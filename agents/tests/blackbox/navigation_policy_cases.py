"""Inert native adapters around the actual browser activity policy boundary."""
import ast
import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


async def assert_navigation_policy_activity_cases(namespace, *, failed_navigation=False,
                                                 native_error_code="net::ERR_EMPTY_RESPONSE"):
    from domains.spawn_browser_agent_v3 import handler as h
    from domains.spawn_browser_agent_v3.navigation_policy import (
        NavigationPolicyBarrier, is_native_navigation_policy_denial, url_digest,
    )
    from _test_utils import setup_mock

    from domains.spawn_browser_agent_v3 import navigation_policy as policy_module
    barrier_type = (getattr(policy_module, "NavigationFailureBarrier", NavigationPolicyBarrier)
                    if failed_navigation else NavigationPolicyBarrier)
    checkpoint_key = "navigation_failure_barrier" if failed_navigation else "navigation_policy_barrier"
    native_error = (f"Navigation failed: {native_error_code}" if failed_navigation else
                    {'code': -32000, 'message': 'navigation to a non-public address is blocked'})
    if not failed_navigation:
        assert is_native_navigation_policy_denial(RuntimeError(native_error))
        for error in (RuntimeError(str(native_error)), RuntimeError({'code': True, 'message': native_error['message']}),
                      RuntimeError({'code': -32000, 'message': 'ordinary failure'}), ValueError(native_error)):
            assert not is_native_navigation_policy_denial(error)
    else:
        assert not is_native_navigation_policy_denial(RuntimeError(native_error))
    saved = {'version': 1, 'task_id': 'task-1', 'session_id': 'session-1',
             'target_id': 'target-original', 'url_sha256': url_digest('https://example.com/login'),
             'denied_url_sha256s': [url_digest('https://example.com/login')]}
    assert barrier_type('task-1', json.loads(json.dumps(saved))).checkpoint() == saved
    debt = barrier_type('task-1', saved)
    debt.deny('session-1', {'target_id': 'second-target', 'url': 'https://second.example/denied'})
    assert not debt.permits_destination('https://example.com/login')
    assert not debt.permits_destination('https://second.example/denied')
    assert barrier_type('task-1', debt.checkpoint()).checkpoint() == debt.checkpoint()
    for bad in ({**saved, 'task_id': 'foreign'}, {**saved, 'version': True}, {**saved, 'url_sha256': 'invalid'}):
        try:
            barrier_type('task-1', bad)
        except ValueError:
            pass
        else:
            raise AssertionError('Malformed/foreign checkpoint admitted')

    source = ast.parse(Path(namespace['__file__']).read_text())
    fixture = next(n for n in source.body if isinstance(n, ast.AsyncFunctionDef)
                   and n.name == 'test_spawn_browser_activity_verified_completion_message_leads_with_goal')
    completed = []
    modes = ('escape', 'restored', 'restored_replacement', 'preparation_failure', 'preparation_pending', 'cancel', 'budget')
    if failed_navigation:
        modes = ('transport_resume',)
    for mode in modes:
        url = 'https://example.com/login'
        target = 'target-original'
        events = []
        contexts = []
        failed_prepare = False
        changed_ack = False
        taken_over = False
        reload_count = 0
        captured_resume = {}
        sync_state = {}
        actor_actions = [
            {'action': 'read_browser_state'}, {'action': 'evaluate', 'params': {'code': 'document.title'}},
            {'action': 'click', 'index': 1}, {'action': 'attempt_completion'},
            {'action': 'input_text', 'params': {'text': 'private'}},
            {'action': 'goto', 'params': {'url': url}},
            {'action': 'goto', 'params': {'url': 'http://127.0.0.1/private'}},
            {'action': 'goto', 'params': {'url': 'https://escape.example/page'},
             'coalesced_calls': [{'action': 'press_key', 'params': {'key': 'a'}},
                                 {'action': 'press_key', 'params': {'key': 'b'}}],
             'coalesced_tool_call_ids': ['call-a', 'call-b']},
            {'action': 'goto', 'params': {'url': 'https://escape.example/{{secret:password}}'}},
            {'action': 'switch_tab', 'params': {'tab_id': 'original'}},
            {'action': 'goto', 'params': {'url': 'https://escape.example/page'}},
            {'action': 'attempt_completion'},
        ]
        if mode == 'transport_resume':
            actor_actions = [{'action':'attempt_completion'}]
        if mode in ('stale_ack', 'schema_ack', 'takeover', 'restored', 'restored_replacement'):
            actor_actions = [{'action': 'goto', 'params': {'url': 'https://escape.example/page'}},
                             {'action': 'attempt_completion'}]
        if mode == 'takeover':
            actor_actions.insert(1, {'action': 'goto', 'params': {'url': 'https://other.example/page'}})
        if mode in ('preparation_failure', 'preparation_pending'):
            actor_actions = [{'action':'goto', 'params':{'url':'https://escape.example/page'}}, {'action':'attempt_completion'}]
        if mode in ('transient', 'readiness_error'):
            actor_actions = [{'action': 'attempt_completion'}]
        if mode == 'budget':
            actor_actions = [{'action': 'attempt_completion'}] * 3

        class Event:
            def __await__(self):
                async def done():
                    if mode == 'cancel':
                        raise asyncio.CancelledError()
                return done().__await__()
            async def event_result(self, **kwargs):
                nonlocal reload_count
                if mode == 'result_cancel':
                    raise asyncio.CancelledError()
                if mode == 'result_seal':
                    raise h.WorkflowGenerationSealed()
                reload_count += 1
                events.append(('reload', url))
                if mode == 'readiness_error':
                    return None
                if (url == 'https://example.com/login' or (mode == 'second_denial' and 'escape.example' in url)):
                    if mode == 'transient':
                        if reload_count == 1:
                            raise RuntimeError('ordinary transient navigation failure')
                    else:
                        raise RuntimeError(native_error)
                return None

        class Session(namespace['_FakeDomSession']):
            event_bus = SimpleNamespace(dispatch=lambda event: Event())
            async def get_tabs(self):
                return [SimpleNamespace(target_id=target, url=url)]

        class Dom(namespace['_FakeDomService']):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.session = Session()
            def get_parked_page_identity(self):
                return {'url': url, 'target_id': target}
            async def get_page_identity(self):
                return {'url': url, 'title': 'fixture'}
            async def get_browser_state(self, **kwargs):
                events.append(('observe', url))
                return {'url': url, 'title': 'fixture', 'dom_tree': 'captured evidence', 'screenshot': None}
            async def get_current_url(self, *, fallback=''):
                return url
            def runtime_current_url(self, *, fallback=''):
                return url

        async def actor(**kwargs):
            await asyncio.sleep(0)
            contexts.append(copy.deepcopy(kwargs.get('turn_messages', [])))
            events.append(('actor', len(contexts)))
            assert len(contexts) <= len(actor_actions), (mode, events)
            return {'action': actor_actions[len(contexts) - 1], 'usage': {}, 'mode': 'waterfall'}

        async def prepare(*args, **kwargs):
            nonlocal failed_prepare
            destination = kwargs.get('target_url') or kwargs.get('url')
            events.append(('prepare', destination))
            if mode == 'preparation_pending':
                await asyncio.Event().wait()
            if mode == 'preparation_failure' and 'escape.example' in destination:
                failed_prepare = True
                raise RuntimeError('fixture preparation unavailable')
            realm = destination.split('/')[2]
            return {'auth_realm': realm, 'auth_options': {'realm': realm}, 'passwords': [], 'passkeys': []}

        async def execute(*args, **kwargs):
            nonlocal url
            action = args[2]
            if mode == 'cancel': raise asyncio.CancelledError()
            events.append(('execute', action['action']))
            assert action['action'] == 'goto', 'Restricted page action reached native executor'
            if kwargs.get('navigation_admission') is not None:
                error = await kwargs['navigation_admission'](action['params']['url'], None)
                assert error is None, error
            url = action['params']['url']
            context = await kwargs['auth_context_for_url'](url)
            return {'success': True, 'current_url': url, 'auth_context': context}

        async def ready(*args, **kwargs):
            nonlocal changed_ack, url, target
            events.append(('ready', url))
            if mode == 'readiness_error' and not changed_ack:
                changed_ack = True
                raise RuntimeError(f'Navigation failed: {native_error_code}')
            if mode == 'schema_ack' and not changed_ack:
                changed_ack = True
                sync_state['current']['delivered_user_instruction_count'] += 1
                events.append(('schema_changed', url))
            if mode == 'stale_ack' and not changed_ack:
                changed_ack = True
                url = 'https://changed.example/page'
                target = 'target-replaced'

        async def rebind(**kwargs):
            return kwargs['current_page'], kwargs['humanizer']

        async def control(*args, **kwargs):
            nonlocal taken_over
            if mode == 'takeover' and contexts and not taken_over:
                taken_over = True
                events.append(('takeover', url))
                return True
            return False

        async def drain_reason(**kwargs):
            return 'worker_draining' if mode == 'drain' and reload_count else None

        async def persist(**kwargs):
            captured_resume.update(copy.deepcopy(kwargs['state']))
            return {'browser_resume_context_ref': 'fixture-local'}

        original_sync = h._sync_browser_user_instructions
        async def sync(**kwargs):
            result = await original_sync(**kwargs)
            sync_state['current'] = result[0]
            return result

        verifier = AsyncMock(return_value={'score': 1.0, 'task_completed': True, 'reasoning': 'fixture',
                                          'structured_response': {'result': 'fixture'}, 'usage': {}})
        class Adapt(ast.NodeTransformer):
            def visit_Assert(self, node):
                return None
            def visit_Assign(self, node):
                node = self.generic_visit(node)
                if mode == 'restored_replacement' and any(isinstance(t, ast.Name) and t.id == 'session_info' for t in node.targets):
                    for k, v in zip(node.value.keys, node.value.values):
                        if isinstance(k, ast.Constant) and k.value == 'session_id':
                            v.value = 'replacement-session'
                return node
            def visit_Call(self, node):
                node = self.generic_visit(node)
                if isinstance(node.func, ast.Name) and node.func.id == 'patch' and node.args and isinstance(node.args[0], ast.Constant):
                    name = node.args[0].value
                    if name.endswith('._call_browser_use_with_rotation'):
                        node.args[1] = ast.Name(id='actor', ctx=ast.Load())
                    if name.endswith('.activity_drain_reason'):
                        node.args[1] = ast.Name(id='drain_reason', ctx=ast.Load())
                    if name.endswith('.call_temporal_activity_from_activity'):
                        node.args[1] = ast.Name(id='verifier', ctx=ast.Load())
                if isinstance(node.func, ast.Name) and node.func.id == 'spawn_browser_agent_activity_v3':
                    state = {'approval_type': 'manual_pause', 'task_id': 'task-1',
                             'durable_browser_runtime': {'credential_reload_pending': True}}
                    state['durable_browser_runtime'][checkpoint_key] = saved
                    for keyword in node.keywords:
                        if keyword.arg == 'write_lock_resume_state':
                            keyword.value = ast.parse(repr(state), mode='eval').body
                return node
        node = Adapt().visit(copy.deepcopy(fixture))
        node.body.append(ast.Return(value=ast.Name(id='result', ctx=ast.Load())))
        env = dict(namespace, actor=actor, verifier=verifier, _FakeDomService=Dom, drain_reason=drain_reason)
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), 'native-policy-full-activity', 'exec'), env)
        setup_mock({})
        with patch.object(h, 'execute_action', execute), patch.object(h, 'prepare_browser_auth', prepare), \
             patch.object(h, 'wait_for_navigation_ready', ready), patch.object(h, '_rebind_browser_tab_runtime', rebind), \
             patch.object(h, '_run_browser_supervisor_recovery', AsyncMock()) as recovery, \
             patch.object(h, '_wait_for_browser_user_control', control), \
             patch.object(h, '_sync_browser_user_instructions', sync), \
             patch.object(h, 'persist_resume_context', persist), \
             patch.object(h, 'MAX_ITERATIONS', 4 if mode == 'budget' else 100):
            try:
                result = await env[node.name]()
            except h.WorkflowGenerationSealed:
                assert mode == 'result_seal' and not contexts and verifier.await_count == 0
                completed.append((mode, 'sealed'))
                continue
            except asyncio.CancelledError:
                assert mode == 'cancel' and verifier.await_count == 0
                completed.append((mode, 'cancelled'))
                continue
        if mode == 'cancel':
            assert result['status'] != 'completed' and verifier.await_count == 0
        elif mode == 'budget':
            assert result['status'] != 'completed' and verifier.await_count == 0
        else:
            assert result['status'] == 'completed', (mode, result, events)
            assert verifier.await_count == 1, (mode, events)
            assert len(contexts) == len(actor_actions), (mode, events)
        assert not any(e[0] == 'reload' for e in events), 'credential preparation forced a reload'
        assert recovery.await_count == 0
        # Only the allowed public alternate page reaches native execution;
        # blocked same-page/private/secret-bearing actions remain blocked.
        if mode not in ('budget', 'cancel', 'transport_resume'):
            assert [e for e in events if e[0] == 'execute'] == [('execute', 'goto')], (mode, events)
        completed.append((mode, result['status']))
    print('Native navigation policy full-activity cases:', completed)
    return completed


async def assert_navigation_admission_at_native_dispatch():
    from domains.spawn_browser_agent_v3.service_actions import _execute_goto, _execute_switch_tab, _execute_navigation_action
    from unittest.mock import AsyncMock
    dispatched = []
    prepared = []
    async def prepare(url):
        prepared.append(url)
        return {'auth_realm': 'other.example'}
    async def admission(url, target):
        assert prepared, 'Admission must recheck after awaited credential preparation'
        return 'identity changed while preparing'
    history = SimpleNamespace(record_action=AsyncMock())
    session = SimpleNamespace(event_bus=SimpleNamespace(dispatch=lambda event: dispatched.append(event)))
    result = await _execute_goto(session=session, dom_service=SimpleNamespace(), action_history=history,
        params={'url': 'https://other.example/page'}, thinking='', session_id='session-1', config=None,
        current_auth_realm='old.example', prepare_credentials_for_url=prepare, navigation_admission=admission)
    assert result['success'] is False and not dispatched and len(prepared) == 1
    context = SimpleNamespace(action_name='open_new_tab', params={'url':'https://other.example/page'},
        current_url='https://old.example/page', current_auth_realm='old.example',
        prepare_credentials_for_url=prepare, navigation_admission=admission, session=session,
        action_history=history, dom_service=SimpleNamespace(), thinking='')
    result = await _execute_navigation_action(context)
    assert result['success'] is False and not dispatched and len(prepared) == 2
    async def tabs():
        return [SimpleNamespace(target_id='target-known', url='https://other.example/page')]
    session.get_tabs = tabs
    async def tab_admission(url, target):
        assert target == 'target-known' and url == 'https://other.example/page'
        return 'tab binding changed'
    result = await _execute_switch_tab(session=session, dom_service=SimpleNamespace(), action_history=history,
        params={'tab_id':'known'}, thinking='', navigation_admission=tab_admission)
    assert result['success'] is False and not dispatched


async def assert_failed_navigation_identity_and_restore():
    from domains.spawn_browser_agent_v3.navigation_policy import (
        NativeNavigationFailure, native_navigation_failure, NavigationFailureBarrier,
        NavigationPolicyBarrier, restore_navigation_barrier, is_native_navigation_policy_denial,
    )
    literal = "Navigation failed: net::ERR_EMPTY_RESPONSE"
    for code in ("net::ERR_EMPTY_RESPONSE", "net::ERR_CONNECTION_CLOSED"):
        failure = native_navigation_failure(RuntimeError("Navigation failed: " + code))
        assert type(failure) is NativeNavigationFailure and failure.args == (code,)
    class UntrustedRuntimeError(RuntimeError):
        pass
    for error in (ValueError(literal), UntrustedRuntimeError(literal), RuntimeError(literal, 'extra'),
                  RuntimeError({'errorText': 'net::ERR_EMPTY_RESPONSE'}),
                  RuntimeError('prefix ' + literal), RuntimeError(literal + ' suffix'),
                  RuntimeError('Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE'),
                  RuntimeError('Navigation failed: net::ERR_ABORTED'),
                  RuntimeError('Navigation failed: net::ERR_BLOCKED_BY_CLIENT'),
                  RuntimeError({'code': -32000, 'message': 'navigation to a non-public address is blocked'}),
                  RuntimeError('Page.navigate() timed out'), asyncio.CancelledError()):
        assert native_navigation_failure(error) is None
    assert not is_native_navigation_policy_denial(RuntimeError(literal))
    barrier = NavigationFailureBarrier('task')
    barrier.deny('session', {'target_id': 'target', 'url': 'https://example.com/failure'})
    runtime = {barrier.checkpoint_key: json.loads(json.dumps(barrier.checkpoint()))}
    restored = restore_navigation_barrier('task', runtime)
    assert type(restored) is NavigationFailureBarrier and restored.active
    assert restored.result_code == 'native_navigation_failed'
    assert not restored.permits_destination('https://example.com/failure')
    for invalid in ({barrier.checkpoint_key: None},
                    {**runtime, NavigationPolicyBarrier.checkpoint_key: barrier.checkpoint()},
                    {barrier.checkpoint_key: {**barrier.checkpoint(), 'task_id': 'foreign'}}):
        try:
            restore_navigation_barrier('task', invalid)
        except ValueError:
            pass
        else:
            raise AssertionError('Conflicting/foreign debt was accepted')
    policy = NavigationPolicyBarrier('task', barrier.checkpoint())
    policy.deny('session', {'target_id': 'next', 'url': 'https://second.example/denied'})
    mixed = NavigationFailureBarrier('task', policy.checkpoint())
    assert not mixed.permits_destination('https://example.com/failure')
    assert not mixed.permits_destination('https://second.example/denied')
