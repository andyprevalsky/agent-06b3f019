"""Full activity cleanup controls reuse existing native fixture adapters."""
import ast
import asyncio
import copy
import json
from pathlib import Path
import socket
from unittest.mock import AsyncMock, patch

async def assert_full_browser_cleanup_failure_boundaries(owning_namespace, *, sealed_only=False, terminal_writer_status=None, terminal_writer_stage="terminal"):
    from domains.spawn_browser_agent_v3 import handler, repo
    from _test_utils import setup_mock, setup_mock_fn, get_captured_requests, clear_captures
    from helpers.workflow_generation import WorkflowGenerationSealed
    source = ast.parse(Path(owning_namespace['__file__']).read_text())
    results = []
    business_results = {}
    connects = []

    def forbidden(*args, **kwargs):
        connects.append(True)
        raise AssertionError('unexpected network in full cleanup fixture')
    with patch.object(socket.socket, 'connect', forbidden):
        cases = [('declined', 500, False), ('completion', 500, False), ('cancellation', 500, False), ('maxstep', 500, False), ('original_error', 500, False), ('declined', 200, False), ('completion', 200, False), ('cancellation', 200, False), ('completion', 409, False), ('maxstep', 200, False), ('completion', 500, True), ('original_error', 500, True), ('completion', 200, True), ('declined_lookup_error', 500, False), ('completion_request_cancelled', None, False), ('cancellation_request_cancelled', None, False)]
        if sealed_only:
            cases = [("cancellation", 500, False), ("original_error", 500, False), ("declined_lookup_sealed", 500, False)]
        if terminal_writer_status is not None:
            cases = [("cancellation", 200, False), ("original_error", 200, False)] if terminal_writer_stage == "terminal" else [("original_error", 200, False)]
        for scenario, http_status, fail_background in cases:
            fixture = '_exercise_browser_resume_user_input' if scenario.startswith('declined') else 'test_spawn_browser_activity_failure_completion_message_leads_with_goal' if scenario == 'original_error' else 'test_spawn_browser_activity_verified_completion_message_leads_with_goal'
            node = copy.deepcopy(next((n for n in source.body if isinstance(n, ast.AsyncFunctionDef) and n.name == fixture)))
            selected_titles = {
                "terminal": {"Browser Session Cancelled", "Task Failed"},
                "progress": {"Updating credential state"},
                "diagnostic": {"Credential state update failed"},
            }[terminal_writer_stage]
            saves = AsyncMock(wraps=repo.save_browser_action_message) if terminal_writer_status is not None else AsyncMock()
            close = AsyncMock(wraps=repo.close_browser_session)

            async def boundary_lookup(*args, **kwargs):
                if scenario == 'declined_lookup_sealed':
                    seal_observed.append(True)
                    raise WorkflowGenerationSealed('owned fixture lookup generation revoked')
                raise RuntimeError('owned fixture ordinary lookup failure')

            class Adapter(ast.NodeTransformer):

                def visit_Assign(self, node):
                    if any(isinstance(target, ast.Name) and target.id == 'save_mock' for target in node.targets):
                        node.value = ast.Name(id='boundary_save', ctx=ast.Load())
                    elif any(isinstance(target, ast.Name) and target.id == 'close_mock' for target in node.targets):
                        node.value = ast.Name(id='boundary_close', ctx=ast.Load())
                    return self.generic_visit(node)

                def visit_Call(self, n):
                    n = self.generic_visit(n)
                    if isinstance(n.func, ast.Name) and n.func.id == 'patch' and n.args and isinstance(n.args[0], ast.Constant):
                        key = n.args[0].value
                        if key == 'domains.spawn_browser_agent_v3.handler.propagate_browser_run_credentials' and terminal_writer_status is not None and terminal_writer_stage == 'diagnostic':
                            n.args[1] = ast.Name(id='boundary_propagation_failure', ctx=ast.Load())
                        elif key == 'domains.spawn_browser_agent_v3.handler.fetch_session_info' and scenario.startswith('declined_lookup'):
                            n.args[1] = ast.Name(id='boundary_lookup', ctx=ast.Load())
                        elif key == 'domains.spawn_browser_agent_v3.handler.close_browser_session':
                            n.args[1] = ast.Name(id='boundary_close', ctx=ast.Load())
                        elif key == 'domains.spawn_browser_agent_v3.handler.save_browser_action_message':
                            n.args[1] = ast.Name(id='boundary_save', ctx=ast.Load())
                        elif key == 'domains.spawn_browser_agent_v3.handler._call_browser_use_with_rotation' and scenario.startswith('cancellation'):
                            n.args[1] = ast.Call(func=ast.Name(id='AsyncMock', ctx=ast.Load()), args=[], keywords=[ast.keyword(arg='side_effect', value=ast.Call(func=ast.Attribute(value=ast.Name(id='asyncio', ctx=ast.Load()), attr='CancelledError', ctx=ast.Load()), args=[], keywords=[]))])
                    return n
            node = Adapter().visit(node)
            if scenario.startswith('declined'):
                # Reuse the actual activity adapter, not the multi-case assertion
                # wrapper. Its old early-return contract no longer exists.
                activity_index = next(i for i, n in enumerate(node.body) if isinstance(n, ast.With)
                                      and any(isinstance(child, ast.Await) and isinstance(child.value, ast.Call)
                                              and isinstance(child.value.func, ast.Name)
                                              and child.value.func.id == 'spawn_browser_agent_activity_v3'
                                              for child in ast.walk(n)))
                node.body = node.body[:activity_index + 1]
                node.body.extend(ast.parse('boundary_actor_turns.extend(actor_call.captured_turns)').body)
            if scenario.startswith('cancellation') or scenario == 'maxstep' or scenario.endswith('request_cancelled') or scenario.startswith('declined_lookup') or sealed_only or terminal_writer_status is not None:
                node.body = [n for n in node.body if not isinstance(n, ast.Assert)]
            if scenario != 'original_error':
                node.body.append(ast.Return(value=ast.Name(id='result', ctx=ast.Load())))
            actor_turns = []
            namespace = dict(owning_namespace, boundary_close=close, boundary_save=saves, boundary_lookup=boundary_lookup, boundary_actor_turns=actor_turns, boundary_propagation_failure=AsyncMock(side_effect=RuntimeError("ordinary owned propagation failure")))
            exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), 'existing-full-activity-fixture', 'exec'), namespace)
            clear_captures()
            setup_mock({'/api/browser-session/close': {'status': http_status, 'json': {'error': 'lifecycle claim held'}}})
            post_seal_requests = []
            cancelled_requests = []
            if scenario.endswith("request_cancelled"):
                import httpx
                def request_cancelled(request):
                    if "/api/browser-session/close" in str(request.url):
                        import json
                        cancelled_requests.append(json.loads(request.content))
                        raise asyncio.CancelledError()
                    return httpx.Response(200, json={})
                setup_mock_fn(request_cancelled)
            queue_events = []
            pre_seal_messages = []
            from helpers import messages as realtime_messages
            original_queue = realtime_messages._queue_realtime_message
            async def observed_queue(message):
                queue_events.append({"afterSeal": bool(seal_observed), "event": message.get("event"), "topic": message.get("topic")})
                if not seal_observed:
                    pre_seal_messages.append(message)
                return await original_queue(message)
            seal_observed = []
            if sealed_only or terminal_writer_status is not None:
                import httpx
                def native_sealed(request):
                    if seal_observed:
                        import hashlib
                        import json
                        def digest(message):
                            return hashlib.sha256(json.dumps(message, sort_keys=True, default=str).encode()).hexdigest()
                        batch = json.loads(request.content).get('messages', []) if '/realtime/v1/api/broadcast' in str(request.url) else []
                        known = {digest(message) for message in pre_seal_messages}
                        post_seal_requests.append({'url': str(request.url), 'onlyPreviouslyEnqueuedMessages': bool(batch) and all(digest(message) in known for message in batch), 'messageDigests': [digest(message) for message in batch]})
                    if terminal_writer_status is not None:
                        import json
                        metadata = json.loads(request.content).get("metadata", {}) if "/messages" in str(request.url) else {}
                        if metadata.get("title") in selected_titles:
                            if terminal_writer_status == 409:
                                seal_observed.append(True)
                            return httpx.Response(terminal_writer_status, json={})
                    elif '/api/browser-session/close' in str(request.url):
                        seal_observed.append(True)
                        raise WorkflowGenerationSealed('owned fixture generation revoked')
                    return httpx.Response(200, json={})
                setup_mock_fn(native_sealed)

            owned_tasks = []
            schedule = handler._schedule_browser_cleanup

            cleanup_arguments = []

            def tracked(**kw):
                cleanup_arguments.append(kw)
                if fail_background:
                    kw["browser_recorder"] = object()
                task = schedule(**kw)
                owned_tasks.append(task)
                return task
            original_finalize = handler._finalize_browser_recording_for_fe_resilient
            failed_finalize = AsyncMock(side_effect=OSError("owned fixture recording finalize failure"))
            error = None
            error_message = None
            outcome = None
            with patch.object(realtime_messages, '_queue_realtime_message', observed_queue), patch.object(handler, '_finalize_browser_recording_for_fe_resilient', failed_finalize if fail_background else original_finalize), patch.object(handler, 'save_browser_action_message', saves), patch.object(handler, '_schedule_browser_cleanup', tracked), patch.object(handler, 'MAX_ITERATIONS', 0 if scenario == 'maxstep' else handler.MAX_ITERATIONS):
                try:
                    if scenario.startswith('declined'):
                        turns = []
                        handler._append_browser_turn_messages(
                            turns,
                            unified_action={"action": "request_user_assistance_for_authentication", "params": {}},
                            result={"success": True, "request_id": "auth-request"},
                            tool_call_id="denied-auth-call",
                        )
                        outcome = await namespace[fixture](
                            approval_type=handler.AUTH_ASSISTANCE_DECLINED,
                            actor_responses_override=[{"action": {"action": "attempt_completion", "params": {}}, "usage": {}}],
                            resume_overrides={"session_id": "session-1", "browser_turn_messages": turns,
                                              "rejected_action": {"tool_call_id": "denied-auth-call", "approval_type": "auth_assistance",
                                                                  "request_id": "auth-request", "url": "https://example.com/login"}},
                        )
                    else:
                        outcome = await namespace[fixture]()
                except BaseException as e:
                    error = type(e).__name__
                    error_message = str(e)
                if owned_tasks:
                    await asyncio.gather(*owned_tasks)
            messages = [c.kwargs for c in saves.await_args_list]
            terminal = [m for m in messages if m.get('action_type') == 'task_complete']
            cleanup = [m for m in terminal if (m.get('extra_metadata') or {}).get('browser_cleanup')]
            closecaptures = [c for c in get_captured_requests() if '/api/browser-session/close' in c['url']]
            for close_call in close.await_args_list:
                assert close_call.kwargs.get('pause') is True, (scenario, close_call)
                if scenario in ('completion', 'maxstep'):
                    assert close_call.kwargs.get('current_url') == 'https://example.com/login', (scenario, close_call)

            r = {'scenario': scenario, 'backgroundFailureInjected': fail_background, 'httpStatus': http_status, 'error': error, 'requests': len(closecaptures), 'closeAwaitCount': close.await_count, 'terminalStatuses': [str(m['status']) for m in terminal], 'terminalTitles': [m['title'] for m in terminal], 'cleanupReceipts': len(cleanup), 'backgroundTasks': len(owned_tasks), 'connectAttempts': len(connects)}
            results.append(r)
            if terminal_writer_status is not None:
                r['terminalWriterStatus'] = terminal_writer_status
                r['terminalWriterStage'] = terminal_writer_stage
                selected = []
                for captured in get_captured_requests():
                    body = captured.get('requestBody') or {}
                    if isinstance(body, str):
                        body = json.loads(body)
                    if '/messages' in captured['url'] and body.get('metadata', {}).get('title') in selected_titles:
                        selected.append(captured)
                assert len(selected) == 1 and close.await_count == 1, r
                if terminal_writer_status == 409:
                    assert error == 'WorkflowGenerationSealed', r
                    assert seal_observed and len(owned_tasks) == 1, r
                    assert cleanup_arguments[0].get('local_only') is True, r
                    assert all(request['onlyPreviouslyEnqueuedMessages'] for request in post_seal_requests), post_seal_requests
                    assert not any(event['afterSeal'] for event in queue_events), queue_events
                    browser = cleanup_arguments[0].get('playwright_browser')
                    if browser is not None:
                        browser.close.assert_not_awaited()
                else:
                    assert error is None and not seal_observed, r
                    assert not cleanup_arguments[0].get('local_only'), r
                    if scenario == 'cancellation':
                        assert outcome['status'] == 'cancelled', r
                    else:
                        assert any('No CDP URL provided' in (message.get('extra_metadata') or {}).get('browser_error_message', '') for message in terminal), r
                r['terminalWriterStatus'] = terminal_writer_status
                r['terminalWriterStage'] = terminal_writer_stage
                r['newPostSealRealtimeEnqueues'] = sum(event['afterSeal'] for event in queue_events)
                continue
            if sealed_only:
                assert error == 'WorkflowGenerationSealed', r
                assert close.await_count == (0 if scenario == "declined_lookup_sealed" else 1), r
                assert not terminal, r
                assert all(request['onlyPreviouslyEnqueuedMessages'] for request in post_seal_requests), post_seal_requests
                assert not any(event['afterSeal'] for event in queue_events), queue_events
                r['preSealBroadcastsDeliveredAfterSeal'] = len(post_seal_requests)
                r['newPostSealRealtimeEnqueues'] = 0
                r['postSealRequests'] = post_seal_requests
                assert seal_observed and len(owned_tasks) == 1, r
                assert cleanup_arguments[0].get('local_only') is True, r
                continue
            if scenario.endswith('request_cancelled'):
                assert len(cancelled_requests) == 1 and close.await_count == 1, r
                assert cancelled_requests[0]['session_id'] == 'session-1', r
                assert any(message.get('title') == 'Browser Session Cleanup Failed' for message in terminal), r
                assert all(message['status'].value == 'ERROR' for message in terminal if (message.get('extra_metadata') or {}).get('excludeFromModel')), r
                if scenario.startswith('cancellation'):
                    assert error == 'CancelledError', r
                else:
                    assert error is None and outcome['status'] == 'cancelled', r
                assert cleanup and all(message['extra_metadata']['browser_cleanup']['http_status'] is None for message in cleanup), r
                continue
            assert len(closecaptures) == 1, r
            assert len(owned_tasks) == 1, r
            if fail_background:
                assert failed_finalize.await_count == 1, r
            expected_status = 'cancelled' if scenario.startswith('cancellation') else 'max_iterations' if scenario == 'maxstep' else 'completed'
            if scenario == 'declined_lookup_error':
                assert error == 'RuntimeError' and error_message == 'owned fixture ordinary lookup failure', r
                assert outcome is None and not actor_turns, r
                assert close.await_args.args[1] == 'session-1', r
                assert any('owned fixture ordinary lookup failure' in (message.get('extra_metadata') or {}).get('browser_error_message', '') for message in terminal), r
            elif scenario != 'original_error':
                assert error is None and outcome['status'] == expected_status, r
                if scenario.startswith('declined'):
                    assert outcome['success'] is True and not outcome.get('user_declined_auth'), r
                    assert len(actor_turns) == 1, r
                    denied = [message for message in actor_turns[0] if message.get('role') == 'tool' and message.get('tool_call_id') == 'denied-auth-call']
                    assert len(denied) == 1 and json.loads(denied[0]['content'])['status'] == 'rejected', r
                    assert json.loads(denied[0]['content'])['success'] is False, r
                    assert not [message for message in actor_turns[0] if message.get('role') == 'user'], r
                elif scenario == 'completion':
                    assert outcome['success'] is True, r
                business = {key: outcome.get(key) for key in ('status', 'success', 'message', 'user_declined_auth', 'task_id', 'session_id', 'structured_response', 'best_effort_response')}
                if scenario in business_results:
                    assert business == business_results[scenario], (business, business_results[scenario])
                else:
                    business_results[scenario] = business
            else:
                assert error is None, r
                assert any('No CDP URL provided' in (message.get('extra_metadata') or {}).get('browser_error_message', '') for message in terminal), r
            resource_terminals = [message for message in terminal if (message.get('extra_metadata') or {}).get('excludeFromModel')]
            assert resource_terminals, r
            if http_status == 200:
                assert not cleanup, r
                assert all(message['status'].value == 'FINISHED' for message in resource_terminals), r
                assert any(message['title'] == 'Browser Session Closed' for message in resource_terminals), r
            else:
                assert cleanup, r
                assert all(message['status'].value == 'ERROR' for message in resource_terminals), r
                assert any(message.get('title') == 'Browser Session Cleanup Failed' for message in resource_terminals), r
                assert all(message['extra_metadata']['browser_cleanup']['http_status'] == http_status for message in cleanup), r
                if outcome is not None:
                    assert outcome['browser_cleanup']['status'] == 'failed', r
    assert not connects, 'network attempted, including swallowed exceptions'
    return results
