"""Offline screenshot tool-result and provider image-count regression coverage."""
import asyncio
import base64
import copy
import json
import os
import runpy
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image
from browser_tools.dom_service import ActionHistory, DOMService
from domains.spawn_browser_agent_v3 import service, service_actions
from helpers.image_count_retry import collect_with_image_count_retry, stream_with_image_count_retry
from helpers.llm import build_llm_messages, build_verifier_context_messages
from helpers.screenshot_history import redact_with_screenshots
from providers.rose.errors import RoseInvalidRequest, RoseAuthError, RoseAllFailed, RoseStepError


def png(color=(12, 34, 56), size=(3, 3)):
    buffer = BytesIO()
    Image.new('RGB', size, color=color).save(buffer, format='PNG')
    return base64.b64encode(buffer.getvalue()).decode()


def setup():
    dom = DOMService('ws://unused')
    dom._runtime_current_url = 'https://example.test/page'
    dom.cdp_multiplexer = object()
    dom.get_parked_page_identity = lambda: {'url': dom._runtime_current_url, 'target_id': 'target'}
    return dom, ActionHistory()


async def capture(dom, history, image):
    with patch.object(dom, 'capture_viewport_png', AsyncMock(return_value=image)), patch(
        'domains.spawn_browser_agent_v3.tilion_worker.stage_upload', return_value={'path': '/files/screenshot.png'}
    ):
        return await service_actions._execute_screenshot(
            session=SimpleNamespace(), dom_service=dom, action_history=history,
            thinking=None, session_id='session', config=None)


def images(messages):
    return [block['image_url']['url'] for message in messages
            for block in (message.get('content') if isinstance(message.get('content'), list) else [])
            if block.get('type') == 'image_url']


async def admitted(dom, history):
    with patch.object(service, 'list_session_files', AsyncMock(return_value=[])):
        context = await service.build_browser_verifier_context(
            goal='Inspect the page', current_url='https://now.test', browser_state={'dom_tree': 'current DOM'},
            action_history=history, config=None, session_id='session', task_id='a-different-task-label')
    return context, build_verifier_context_messages(context, 'Verify', call_site='verifier_browser')


async def test_default_history_and_descriptive_context():
    dom, history = setup()
    image = png()
    await capture(dom, history, image)
    entries = history.get_entries()
    assert entries[0]['screenshot'] == image
    context, messages = await admitted(dom, history)
    assert images(messages) == ['data:image/png;base64,' + image]
    row = next(row for row in context if row.get('metadata', {}).get('screenshot_b64'))
    description = row['metadata']['screenshot_context']
    assert description['captured_at'] > 0 and description['url'] == 'https://example.test/page'
    assert description['step'] == 1 and 'captured_at=' in row['text']
    assert row['metadata'].get('excludeFromModel') is not True
    assert history.screenshot_evidence('other-session', 'other-task')[0]['screenshot_b64'] == image


async def test_secret_text_redaction_preserves_captured_image():
    dom, history = setup()
    dom.register_secret_refs({'password': 'private-password'})
    dom.mark_secret_used()
    dom._runtime_current_url = 'https://example.test/?value=private-password'
    image = png()
    result = await capture(dom, history, image)
    assert result['success'] and history.get_entries()[0]['screenshot'] == image
    safe = dom.model_visible_value({'text': 'private-password', 'screenshot_b64': image})
    assert 'private-password' not in safe['text'] and safe['screenshot_b64'] == image
    nested = dom.model_visible_value({'value': {'screenshot': 'private-password'}})
    assert 'private-password' not in json.dumps(nested)
    for page_type in ([], {}, ['image'], {'kind': 'image'}):
        assert dom.model_visible_value({'type': page_type, 'text': 'private-password'})['type'] == page_type
    _, messages = await admitted(dom, history)
    assert images(messages) == ['data:image/png;base64,' + image]
    assert 'private-password' not in json.dumps(messages)


async def test_identity_is_description_not_admission():
    dom, history = setup()
    dom.get_parked_page_identity = lambda: (_ for _ in ()).throw(RuntimeError('no focused identity'))
    image = png()
    result = await capture(dom, history, image)
    assert result['success'] and history.get_entries()[0]['screenshot'] == image
    assert len((await admitted(dom, history))[1]) > 0


async def test_all_captures_survive_restore():
    dom, history = setup()
    for index in range(24):
        await capture(dom, history, png((index, 2, 3)))
    before = history.get_entries()
    history.restore_entries(before)
    assert history.get_entries() == before
    assert len(images((await admitted(dom, history))[1])) == 24


async def test_no_synthetic_screenshot():
    dom, _ = setup()
    state = SimpleNamespace(url='https://example.test', title='page', dom_state=None)
    dom._session = SimpleNamespace(get_browser_state_summary=AsyncMock(return_value=state))
    dom._page_geometry = lambda _: {'viewport_width': 10, 'viewport_height': 10, 'scroll_x': 0, 'scroll_y': 0, 'pages_above': 0, 'pages_below': 0, 'total_pages': 1}
    dom._extract_page_statistics = lambda _: {}
    dom._remember_rendered_image_urls = lambda _: None
    dom._remember_document_images = AsyncMock()
    dom._serialized_dom_tree = lambda *args: ''
    dom._summarized_tabs = lambda _: []
    dom._capture_surface_screenshot = AsyncMock(return_value=None)
    with patch('browser_tools.dom_service._extract_media_candidates_from_dom_state', return_value=[]):
        result = await dom.get_browser_state()
    assert not result.get('screenshot') and result['screenshot_unavailable'] is True


async def test_export_and_actor_rehydrate():
    from domains.spawn_browser_agent_v3.service_visual_evidence import persist_terminal_visual_evidence
    dom, history = setup(); image = png()
    await capture(dom, history, image)
    save = AsyncMock(return_value=True)
    with patch('domains.spawn_browser_agent_v3.repo.save_browser_action_message', save):
        result = await persist_terminal_visual_evidence(action_history=history, dom_service=dom,
            session_id='session', task_id='context-only', agent_id='agent', redact=dom.model_visible_value)
    assert result['persisted'] == 1
    kwargs = save.await_args.kwargs
    assert kwargs['extra_metadata'].get('excludeFromModel') is not True
    context = [{'role': 'TOOL', 'text': kwargs['message'], 'metadata': kwargs['extra_metadata']}]
    original = copy.deepcopy(context)
    messages = await build_llm_messages(context, 'system')
    assert images(messages) == ['data:image/png;base64,' + image]
    assert context == original
    assert 'captured_at=' in json.dumps(messages) and 'https://example.test/page' in json.dumps(messages)
    from helpers.llm import convert_context_to_messages
    assert images(convert_context_to_messages(context)) == images(messages)


def many_images(count=15):
    return [{'role': 'user', 'content': [{'type': 'text', 'text': f'capture {i}'},
        {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + png((i, 0, 0))}}]} for i in range(count)]


async def test_count_fallback_last_n_and_no_mutation():
    for message, limit in [('Too many images', 10), ('At most 3 images are allowed', 3),
                           ('The maximum number of images is 2', 2), ('Too many images: 15 > 4', 4)]:
        source = many_images(); original = copy.deepcopy(source); calls = []
        async def collect(**kwargs):
            calls.append(kwargs['messages'])
            if len(calls) == 1: raise RoseInvalidRequest(message, status=400)
            return 'ok'
        assert await collect_with_image_count_retry(collect, messages=source) == 'ok'
        assert len(images(calls[0])) == 15 and images(calls[1]) == images(source)[-limit:]
        assert source == original and calls[0] is source


async def test_fallback_is_bounded_and_unrelated_errors_propagate():
    for error in [RoseInvalidRequest('bad response schema', status=400), RoseAuthError('denied', status=401),
                  asyncio.CancelledError(), RoseAllFailed('failed', step_errors=[RoseStepError('a', RoseInvalidRequest('too many images')), RoseStepError('b', RoseAuthError('denied'))])]:
        calls = []
        async def collect(**kwargs): calls.append(kwargs); raise error
        try: await collect_with_image_count_retry(collect, messages=many_images())
        except BaseException as raised: assert raised is error
        else: raise AssertionError('error swallowed')
        assert len(calls) == 1
    calls=[]; error=RoseInvalidRequest('too many images')
    async def collect(**kwargs): calls.append(kwargs); raise error
    try: await collect_with_image_count_retry(collect, messages=many_images())
    except RoseInvalidRequest as raised: assert raised is error
    else: raise AssertionError('repeat rejection swallowed')
    assert len(calls) == 2


async def test_stream_retry_preserves_partial_output_and_deadline():
    source=many_images(); original=copy.deepcopy(source); calls=[]
    async def stream(**kwargs):
        calls.append(kwargs)
        if len(calls)==1: raise RoseInvalidRequest('at most 2 images')
        yield SimpleNamespace(kind='content', data={'text':'ok'})
    assert len([c async for c in stream_with_image_count_retry(stream,messages=source,deadline_s=30)]) == 1
    assert len(calls)==2 and len(images(calls[1]['messages']))==2
    assert 0 < calls[1]['deadline_s'] <= 30 and source==original
    calls.clear();error=RoseInvalidRequest('too many images')
    async def partial(**kwargs):
        calls.append(kwargs)
        yield SimpleNamespace(kind='content',data={'text':'already sent'})
        raise error
    try:
        async for _ in stream_with_image_count_retry(partial,messages=source): pass
    except RoseInvalidRequest as raised: assert raised is error
    else: raise AssertionError('partial stream retried')
    assert len(calls)==1


async def test_capture_cancellation():
    dom, history=setup()
    with patch.object(dom,'capture_viewport_png',AsyncMock(side_effect=asyncio.CancelledError())):
        try:
            await service_actions._execute_screenshot(session=None, dom_service=dom,
                action_history=history, thinking=None, session_id='session', config=None)
        except asyncio.CancelledError: pass
        else: raise AssertionError('cancel swallowed')
    assert history.get_entries()==[]


async def test_actual_browser_client_retries_count_only():
    from providers.rose.client import RoseClient
    from providers.rose.types import RoseResponse
    source=many_images(); original=copy.deepcopy(source); calls=[]
    async def collect(**kwargs):
        calls.append(copy.deepcopy(kwargs['messages']))
        if len(calls)==1: raise RoseInvalidRequest('at most 3 images')
        return RoseResponse(content='{"action":[{"screenshot":{}}]}',actual_model='test',request_id='test')
    client=RoseClient()
    with patch.object(client,'collect',side_effect=collect), patch('helpers.observability.dump_llm_context'):
        result=await client.complete_browser_use(task='inspect',browser_state={},action_history=[],
            available_actions=['screenshot'],turn_messages=source)
    assert result['action']['action']=='screenshot'
    assert len(images(calls[0]))==15 and images(calls[1])==images(source)[-3:]
    assert source==original


async def test_actual_verifier_stream_retries_count_only():
    from helpers.llm import _call_llm_verifier
    from providers.rose.types import StreamChunk
    calls=[]; source=many_images(); original=copy.deepcopy(source)
    async def complete(*args,**kwargs):
        calls.append(copy.deepcopy(kwargs['messages']))
        if len(calls)==1: raise RoseInvalidRequest('at most 2 images')
        yield StreamChunk('content', {'text':'{"reasoning":"observed","score":0.5}'})
        yield StreamChunk('done',{})
    with patch('providers.demo_cache.rose_cache.cached_complete',side_effect=complete):
        result,_=await _call_llm_verifier(source,'rose',None)
    assert result['score']==0.5 and len(calls)==2
    assert len(images(calls[0]))==15 and images(calls[1])==images(source)[-2:]
    assert source==original


async def test_actual_actor_stream_retries_count_only():
    from helpers.llm import call_llm_structured_streaming
    from providers.rose.types import StreamChunk
    from pydantic import BaseModel
    class Output(BaseModel):
        value: str
    source=many_images(); original=copy.deepcopy(source); calls=[]
    async def complete(*args,**kwargs):
        calls.append(copy.deepcopy(kwargs['messages']))
        if len(calls)==1: raise RoseInvalidRequest('at most 4 images')
        yield StreamChunk('content',{'text':'{"value":"ok"}'})
        yield StreamChunk('done',{})
    async def on_chunk(*args): pass
    with patch('providers.demo_cache.rose_cache.cached_complete',side_effect=complete):
        result,_,_=await call_llm_structured_streaming(source,'rose',0.3,512,Output,on_chunk)
    assert result.value=='ok' and len(calls)==2
    assert len(images(calls[0]))==15 and images(calls[1])==images(source)[-4:]
    assert source==original


async def test_old_capture_time_stays_unrecorded_and_call_id_is_descriptive():
    from helpers.screenshot_history import screenshot_message
    dom,history=setup();await capture(dom,history,png())
    history.describe_screenshot_call(1,'original-call')
    entry=history.get_entries()[0]
    assert screenshot_message(entry)['metadata']['toolCallId']=='original-call'
    entry['result']['screenshot_context'].pop('captured_at')
    restored=ActionHistory();restored.restore_entries([entry])
    message=screenshot_message(restored.get_entries()[0])
    assert 'capture time unrecorded' in message['text']
    assert 'captured_at' not in message['metadata']['screenshot_context']


async def test_legacy_screenshot_exclusion_does_not_hide_images():
    from helpers.context_compaction import is_excluded_from_model
    row={'role':'TOOL','text':'old capture','metadata':{'toolName':'historical_screenshot',
        'toolCallId':'original','toolStatus':'FINISHED','excludeFromModel':True,'screenshot_b64':png()}}
    assert not is_excluded_from_model(row)
    assert images(await build_llm_messages([row],'system'))
    assert images(build_verifier_context_messages([row],'system'))
    unrelated=copy.deepcopy(row);unrelated['metadata']['toolName']='background_internal'
    assert is_excluded_from_model(unrelated)
    assert not images(await build_llm_messages([unrelated],'system'))
    verbose={'role':'TOOL','text':'x'*200000,'metadata':{'toolName':'read_file','toolStatus':'FINISHED'}}
    assert images(build_verifier_context_messages([copy.deepcopy(verbose) for _ in range(20)]+[row],'system'))


async def test_handler_image_projection_preserves_original_result():
    import ast
    from helpers.screenshot_history import screenshot_context_text
    path=Path(os.environ.get('STAGED_SCREENSHOT_HANDLER', Path(__file__).resolve().parents[2]/'domains/spawn_browser_agent_v3/handler.py'))
    tree=ast.parse(path.read_text())
    names={'_model_visible_browser_message','_model_visible_browser_turn_messages','_model_visible_browser_verifier_context'}
    nodes=[node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name in names]
    env={'Any':object,'Dict':dict,'List':list,'json':json,'math':__import__('math'),
         'redact_with_screenshots':redact_with_screenshots,'is_inter_agent_message':lambda message:False}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),env)
    dom,history=setup();dom.mark_secret_used();image=png();await capture(dom,history,image)
    row={'role':'user','content':[{'type':'text','text':'capture time unrecorded'},
        {'type':'image_url','image_url':{'url':'data:image/png;base64,'+image}}]}
    original = copy.deepcopy(row)
    visible=env['_model_visible_browser_turn_messages']([row],dom.model_visible_value,secret_values_used=True)
    assert images(visible) == ['data:image/png;base64,' + image]
    assert row == original, 'projection mutated original screenshot history'
    context,_=await admitted(dom,history)
    projected=env['_model_visible_browser_verifier_context'](context,dom,{})
    assert images(build_verifier_context_messages(projected,'system'))==['data:image/png;base64,'+image]


class ScreenshotRevision(unittest.IsolatedAsyncioTestCase):
    pass

for name, fn in list(globals().items()):
    if name.startswith('test_'):
        async def method(self, function=fn): await function()
        setattr(ScreenshotRevision,name,method)
del fn, method

if __name__=='__main__': unittest.main()
