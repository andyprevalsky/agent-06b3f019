"""Document-scoped scroll evidence; no model/provider calls."""
import asyncio
import copy
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from browser_tools.dom_service import DOMService
from domains.spawn_browser_agent_v3.service_actions import _ActionContext, _execute_interaction_action, _execute_resolved_action
from helpers.workflow_generation import WorkflowGenerationSealed
from temporalio.exceptions import CancelledError as TemporalCancelledError


def measurement(y=0, **changes):
    return dict(scope='document', target_id='target', time_origin_ms=1000., captured_epoch_ms=2000., captured_monotonic_s=1., scroll_x=0., scroll_y=float(y), viewport_width=800., viewport_height=600., scroll_width=800., scroll_height=2400., **changes)


def context(observer, humanizer=None, index=None, session=None):
    dom=SimpleNamespace(observe_document_scroll=observer, get_element_coordinates=AsyncMock(return_value=(20,30)))
    history=SimpleNamespace(record_action=AsyncMock())
    fields=dict.fromkeys(_ActionContext.__dataclass_fields__)
    fields.update(dom_service=dom,action_history=history,humanizer=humanizer or SimpleNamespace(scroll=AsyncMock()),action_name='scroll',params={'direction':'down','amount':300},index=index,session=session)
    return _ActionContext(**fields)


async def test_scroll_result_observation_contract():
    # Exercise the production dispatcher, whose operational-error handler must
    # not convert cancellation/sealing into a failed tool result/history write.
    for after_action in (False, True):
        for error in (asyncio.CancelledError(), WorkflowGenerationSealed('sealed'), TemporalCancelledError('cancelled')):
            observer = AsyncMock(side_effect=[measurement(), error] if after_action else error)
            dom = SimpleNamespace(session=object(), observe_document_scroll=observer)
            history = SimpleNamespace(record_action=AsyncMock())
            humanizer = SimpleNamespace(scroll=AsyncMock())
            try:
                await _execute_resolved_action(dom, history, {'action':'scroll','params':{'direction':'down','amount':300}}, humanizer=humanizer)
            except type(error) as caught:
                assert caught is error
            else:
                raise AssertionError('dispatcher swallowed control error')
            assert humanizer.scroll.await_count == int(after_action)
            history.record_action.assert_not_awaited()
    ordinary = RuntimeError('ordinary scroll failure')
    dom = SimpleNamespace(session=object(), observe_document_scroll=AsyncMock(return_value=measurement()))
    history = SimpleNamespace(record_action=AsyncMock())
    result = await _execute_resolved_action(dom, history, {'action':'scroll','params':{'direction':'down','amount':300}}, humanizer=SimpleNamespace(scroll=AsyncMock(side_effect=ordinary)))
    assert result == {'success':False,'error':str(ordinary)}
    assert history.record_action.await_count == 1
    for before,after,expected in [(measurement(),measurement(300),300.),(measurement(1800),measurement(1800),0.)]:
        c=context(AsyncMock(side_effect=[before,after])); result=await _execute_interaction_action(c)
        assert result['document_scroll']['delta_y']==expected
        assert result['document_scroll']['scope']=='document'
        assert result['document_scroll']['status']=='observed'
        assert c.action_history.record_action.await_args.kwargs['result']==result
    for field,value in [('target_id','other'),('time_origin_ms',1001.)]:
        after=measurement(300); after[field]=value
        c=context(AsyncMock(side_effect=[measurement(),after])); result=await _execute_interaction_action(c)
        assert result['document_scroll']['status']=='incomparable'
        assert 'delta_y' not in result['document_scroll']
    for observer in (None,AsyncMock(return_value=None),AsyncMock(side_effect=OSError('secret URL must not appear'))):
        c=context(observer); result=await _execute_interaction_action(c)
        assert result['success'] is True and result['document_scroll']['status']=='unknown'
        assert 'secret' not in str(result)
    c=context(AsyncMock(side_effect=[measurement(),measurement()] ),index=4)
    result=await _execute_interaction_action(c)
    assert result['document_scroll']['scope']=='document'
    assert 'element_delta_y' not in result['document_scroll']
    assert result['document_scroll']['delta_y']==0
    for error in (asyncio.CancelledError(), WorkflowGenerationSealed('sealed'), TemporalCancelledError('cancelled')):
        c=context(AsyncMock(side_effect=error))
        try: await _execute_interaction_action(c)
        except type(error): pass
        else: raise AssertionError('observation swallowed control error')
        c.humanizer.scroll.assert_not_awaited()
    error=RuntimeError('original action failure'); c=context(AsyncMock(return_value=measurement()),SimpleNamespace(scroll=AsyncMock(side_effect=error)))
    try: await _execute_interaction_action(c)
    except RuntimeError as got: assert got is error
    else: raise AssertionError('action failure hidden')
    assert c.dom_service.observe_document_scroll.await_count==1
    c.action_history.record_action.assert_not_awaited()
    for error in (asyncio.CancelledError(), WorkflowGenerationSealed('sealed'), TemporalCancelledError('cancelled')):
        c=context(AsyncMock(side_effect=[measurement(),error]))
        try: await _execute_interaction_action(c)
        except type(error): pass
        else: raise AssertionError('post-action observation swallowed control error')
        c.humanizer.scroll.assert_awaited_once()
        c.action_history.record_action.assert_not_awaited()
    async def blocked(): await asyncio.Event().wait()
    c=context(blocked); started=time.monotonic()
    result=await _execute_interaction_action(c)
    assert result['document_scroll']['status']=='unknown'
    assert time.monotonic()-started < 1.5
    # Native fallback dispatch is still awaited and returns the same evidence.
    class Event:
        def __await__(self): return asyncio.sleep(0).__await__()
        event_result=AsyncMock(return_value=None)
    event=Event(); c=context(AsyncMock(side_effect=[measurement(),measurement(300)]),session=SimpleNamespace(event_bus=SimpleNamespace(dispatch=lambda _:event)))
    c.humanizer=None
    result=await _execute_interaction_action(c)
    assert result['document_scroll']['delta_y']==300
    event.event_result.assert_awaited_once_with(raise_if_any=True,raise_if_none=False)


async def test_document_scroll_measurement_validation():
    value={k:v for k,v in measurement().items() if k not in ('scope','target_id','captured_epoch_ms','captured_monotonic_s')}
    async def run(payload, change=False):
        service=DOMService.__new__(DOMService)
        async def evaluate(**kwargs):
            assert kwargs['params']['returnByValue'] is True
            if change: session.agent_focus_target_id='new'
            return {'result':{'value':payload}}
        cdp=SimpleNamespace(target_id='target',session_id='cdp',cdp_client=SimpleNamespace(send=SimpleNamespace(Runtime=SimpleNamespace(evaluate=evaluate))))
        session=SimpleNamespace(agent_focus_target_id='target',get_or_create_cdp_session=AsyncMock(return_value=cdp)); service._session=session
        return await service.observe_document_scroll()
    result=await run(value)
    assert result['scroll_y']==0 and result['target_id']=='target'
    assert result['captured_epoch_ms']>0 and result['captured_monotonic_s']>0
    for key in value:
        bad=copy.deepcopy(value); bad.pop(key); assert await run(bad) is None
        for invalid in (True,float('nan'),float('inf'),'0'):
            bad=copy.deepcopy(value); bad[key]=invalid; assert await run(bad) is None
    assert await run(value,change=True) is None
    service=DOMService.__new__(DOMService); service._session=None
    assert await service.observe_document_scroll() is None
    for error in (asyncio.CancelledError(),WorkflowGenerationSealed('sealed')):
        service._session=SimpleNamespace(agent_focus_target_id='target',get_or_create_cdp_session=AsyncMock(side_effect=error))
        try: await service.observe_document_scroll()
        except type(error): pass
        else: raise AssertionError('control exception swallowed')
    service._session=SimpleNamespace(agent_focus_target_id='target',get_or_create_cdp_session=AsyncMock(side_effect=OSError('private')))
    assert await service.observe_document_scroll() is None


async def test_document_scroll_native(stack):
    from browser_tools.humanizer import BrowserHumanizer
    async with stack() as (service,browser,gateway):
        page=browser.contexts[0].pages[0]
        await page.set_content('<style>body{margin:0}main{height:4000px}</style><main>local only</main>')
        before=await service.observe_document_scroll(); assert before is not None
        assert before['viewport_height']==await page.evaluate('window.innerHeight')
        humanizer=BrowserHumanizer(page,page)
        await page.mouse.move(500,325); humanizer._last_pos=(500,325)
        c=context(service.observe_document_scroll,humanizer); c.dom_service=service
        try:
            result=await _execute_interaction_action(c)
            obs=result['document_scroll']; assert obs['status']=='observed' and obs['delta_y']>0,obs
            await page.evaluate('window.scrollTo(0,document.scrollingElement.scrollHeight)')
            result=await _execute_interaction_action(c)
            assert result['document_scroll']['delta_y']==0,result
            await page.set_content('<body>short local page</body>')
            result=await _execute_interaction_action(c)
            assert result['document_scroll']['delta_y']==0,result
        finally: await humanizer.close()
        # Real native ScrollEvent branch, not only a mocked awaitable.
        await page.set_content('<style>body{margin:0}main{height:4000px}</style><main>native fallback</main>')
        c=context(service.observe_document_scroll,session=service._session); c.dom_service=service; c.humanizer=None
        result=await _execute_interaction_action(c)
        assert result['document_scroll']['status']=='observed' and result['document_scroll']['delta_y']>0,result
        assert gateway.rejected_4409==0
