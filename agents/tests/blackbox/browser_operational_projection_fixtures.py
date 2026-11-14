"""Synthetic fixtures for the native operational-source / observation-view boundary."""
import asyncio, base64, contextlib, copy, json
from screenshot_revision_cases import png
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch


def synthetic_purchase():
    product = "https://shop.example.test/products/linen-journal"
    image = "https://images.example.test/linen-journal.png"
    receipt = {"merchant": "Fixture Stationery", "currency": "USD", "line_items": [
        {"name": "Linen Journal", "product_url": product, "image_url": image,
         "rating": "4.7 stars", "review_count": "19 reviews", "quantity": 2,
         "unit_price_cents": 1100, "line_total_cents": 2200}],
        "fees": [{"label": "Shipping", "amount_cents": 200}, {"label": "Tax", "amount_cents": 199}],
        "subtotal_cents": 2200, "total_cents": 2599}
    notification = {"trigger_type": "purchase", "action": "buy journals",
        "service": {"name": "Fixture Stationery", "domain": "shop.example.test", "url": "https://shop.example.test/checkout"},
        "media": [{"url": image, "alt": "Linen Journal", "kind": "product"}],
        "purchase": {"items": [{"title": "Linen Journal", "price": "$11.00", "quantity": "2",
            "rating": "4.7 stars", "review_count": "19 reviews", "product_url": product, "image_url": image}],
            "totals": {"subtotal": "$22.00", "shipping": "$2.00", "tax": "$1.99", "total": "$25.99"}}}
    return ({"action": "request_payment_card", "params": receipt},
            {"action": "generate_write_lock_notification", "params": notification})

async def test_activity_manager_projection(m):
 from temporalio.testing import ActivityEnvironment
 from domains.spawn_browser_agent_v3 import handler as h
 from browser_tools.dom_service import DOMService
 action, fork = synthetic_purchase()
 receipt=copy.deepcopy(action['params']);image=receipt['line_items'][0]['image_url'];url=receipt['line_items'][0]['product_url'].split('/products/')[0]+'/checkout'
 secret='synthetic-private-purchase-secret';refs={'pwd:fixture':secret};snapshots=[];decisions=[]
 class FixtureDom(m._FakeDomService):
  get_page_image_urls=DOMService.get_page_image_urls
  model_visible_action_result=DOMService.model_visible_action_result
  def runtime_current_url(self,*,fallback=''):return url
  async def get_current_url(self,*,fallback=''):return url
  async def get_page_identity(self):return self.model_visible_value({'url':url,'title':'Checkout'})
  async def get_browser_state(self,include_screenshot=False):return self.model_visible_value({'url':url,'title':'Checkout','dom_tree':'Checkout','screenshot':'PRIVATE_RASTER','media':[{'url':'data:image/png;base64,PRIVATE'}]})
 async def model_fixture(**kwargs):
  visible = {k: kwargs.get(k) for k in ('turn_messages', 'browser_state', 'extra_user_messages', 'action_entries')}
  assert secret not in json.dumps(visible, default=str)
  assert 'operational_source' not in json.dumps(visible, default=str)
  decisions.append(kwargs.get('call_site') or 'browser')
  return {'action':copy.deepcopy(fork if str(kwargs.get('call_site','')).startswith('write_lock') else action),'usage':{}}
 async def persist(**kwargs):
  snapshots.append(copy.deepcopy(kwargs['state']))
  return {'browser_resume_context_ref':{'paths':['offline-private-snapshot'],'sha256':'offline-only'}}
 session={'session_id':'session-1','ws_url':'ws://offline','debug_url':'https://offline.invalid/view','same_session_available':True,'auth_options':{'realm':url.split('/')[2]},'browser_session_metadata':{'provider':'kernel'},'passwords':[],'user_settings':{}}
 browser=SimpleNamespace(contexts=[SimpleNamespace(pages=[SimpleNamespace()])],close=AsyncMock())
 prefix='domains.spawn_browser_agent_v3.handler.'
 native_start=await m.native_browser_start_source('1970-01-01T00:00:00+00:00',tool_call_id='tool-1')
 patches=[patch(prefix+'load_config',return_value=m._fake_config()),patch(prefix+'poll_new_messages',AsyncMock(return_value=[native_start])),patch(prefix+'fetch_session_info',AsyncMock(return_value=session)),patch(prefix+'fetch_recent_otps',AsyncMock(return_value=[])),patch(prefix+'get_model_pricing_with_fallback',AsyncMock(return_value={'input_cents_per_1k':0,'output_cents_per_1k':0})),patch(prefix+'BrowserAgentRecorder.create',AsyncMock(return_value=None)),patch(prefix+'_call_browser_use_with_rotation',AsyncMock(side_effect=model_fixture)),patch(prefix+'extract_session_files',AsyncMock(return_value=[])),patch(prefix+'disconnect_browser_after_passkey_capture',AsyncMock()),patch(prefix+'propagate_browser_run_credentials',AsyncMock(return_value={'outcome':'unknown','refs':0,'applied':0})),patch(prefix+'close_browser_session',AsyncMock()),patch(prefix+'save_browser_action_message',AsyncMock()),patch(prefix+'save_browser_assistant_message',AsyncMock()),patch(prefix+'persist_resume_context',AsyncMock(side_effect=persist)),patch('domains.spawn_browser_agent_v3.streaming.stream_assistant_chunk',AsyncMock()),patch('domains.spawn_browser_agent_v3.streaming.stream_tool_event',AsyncMock()),patch('browser_tools.dom_service.DOMService',FixtureDom),patch('browser_tools.humanizer.BrowserHumanizer',m._FakeHumanizer),patch('playwright.async_api.async_playwright',return_value=m._FakeAsyncPlaywright(m._FakePlaywright(browser))),patch(prefix+'live_tab_looks_challenged',AsyncMock(return_value=False)),patch('domains.spawn_browser_agent_v3.service.list_session_files',AsyncMock(return_value=[]))]
 with contextlib.ExitStack() as stack:
  for p in patches:stack.enter_context(p)
  result=await ActivityEnvironment().run(h.spawn_browser_agent_activity_v3,user_id='user-1',agent_id='agent-1',goal='Recorded purchase checkout',tool_call_id='tool-1',task_id='task-1',is_resume=True,use_claude_mode=False,start_url=url,output_schema={'fields':[{'name':'result','type':'string'}]},write_lock_resume_state={'approval_type':'manual_pause','secret_redaction_refs':refs,'secret_values_used':True})
 assert result['status']=='awaiting_payment_card_approval',result.get('message')
 assert FixtureDom.last_instance.secret_values_used is True
 # Real manager receives exactly the real returned result, not a second receipt fixture.
 original=m._FakePaymentGateHandle
 class ActivityReturn(original):
  def __init__(self,payload):super().__init__(json.loads(json.dumps(result)) if payload.get('status')=='awaiting_payment_card_approval' else payload)
 approvals=[]
 with patch.dict(m._drive_payment_card_gate.__globals__, {'_FakePaymentGateHandle': ActivityReturn}):
  await m._drive_payment_card_gate(mint_results=[{'status':'agentcard_setup_required','connectUrl':'https://offline.invalid/setup'}],agentcard_connected=False,approval_calls=approvals)
 assert approvals,'real manager did not reach approval boundary'
 payload=approvals[0]['metadata']['requestPaymentCard'];actual=payload['lineItems'][0].get('imageUrl');safe=FixtureDom.last_instance.model_visible_value({'screenshot':'PRIVATE_RASTER','image_url':'data:image/png;base64,PRIVATE','media':[{'url':'arbitrary'}],'secret':secret})
 facts={'source_model_image_present':bool(image),'activity_return_image_present':bool(result['payment_request']['line_items'][0].get('image_url')),'manager_image_present':bool(actual),'manager_image_matches_original':actual==image,'secret_used':FixtureDom.last_instance.secret_values_used,'secret_absent_approval':secret not in json.dumps(approvals,default=str),'ordinary_fields_retained':all(k in safe for k in ['screenshot','image_url','media']),'secret_absent_projection':secret not in json.dumps(safe),'model_fixture_calls':decisions,'actual_activity_status':result['status'],'private_continuity_snapshots':len(snapshots),'write_lock_notification_media_present':bool((result.get('write_lock_notification')or{}).get('media'))}
 assert facts['secret_used'] and facts['secret_absent_approval'] and facts['ordinary_fields_retained'] and facts['secret_absent_projection']
 assert actual==image, 'Captured line-item image URL lost between real private activity return and manager approval metadata'

 assert facts['write_lock_notification_media_present']
 assert approvals[0]['metadata']['writeLockNotification'] == json.loads(json.dumps(result['write_lock_notification']))
 assert approvals[0]['metadata']['writeLockNotification']['media'][0]['url'] == image
 assert type(result) is dict
 assert 'operational_source' not in json.dumps(result)
 from utils.payment_card import normalize_payment_payload
 expected = normalize_payment_payload(receipt, 'user-1')
 assert payload['lineItems'] == expected['lineItems']
 assert payload['fees'] == expected['fees'] == [{'label': 'Shipping', 'amountCents': 200}, {'label': 'Tax', 'amountCents': 199}]
 for key in ('subtotalCents', 'totalCents', 'currency', 'fingerprint'):
  assert payload[key] == expected[key]
 assert snapshots and all(isinstance(snapshot, dict) for snapshot in snapshots)


def test_typed_source_guards_and_scalar_policy():
    from browser_tools.control_projection import OperationalResult, project_operational_source, retain_operational_source, _project_declared
    from browser_tools.dom_service import DOMService
    from browser_tools.schemas import RequestPaymentCardBrowserTool, GenerateWriteLockNotificationTool
    from pydantic import BaseModel
    from utils.payment_card import normalize_payment_payload
    from urllib.parse import quote
    action, fork = synthetic_purchase()
    receipt = action['params']
    source = RequestPaymentCardBrowserTool.model_validate({'tool': action['action'], **receipt})
    dom = DOMService('ws://offline')
    secret = 'private fixture / token'
    dom.register_secret_refs({'pwd:fixture': secret, 'pwd:numeric': '2200', 'pwd:key': 'image_url'})
    dom.mark_secret_used()
    projected = project_operational_source(source, dom.model_visible_value)
    baseline = dom.model_visible_value(receipt)
    assert projected['subtotal_cents'] == baseline['subtotal_cents']
    assert projected['line_items'][0]['line_total_cents'] == baseline['line_items'][0]['line_total_cents']
    assert normalize_payment_payload(projected, 'u')['subtotalCents'] == normalize_payment_payload(baseline, 'u')['subtotalCents'] == 0
    assert projected['line_items'][0]['image_url'] == receipt['line_items'][0]['image_url']
    wrapped = OperationalResult({'payment_request': baseline}, field='payment_request', source=source)
    assert json.loads(json.dumps(wrapped)) == {'payment_request': baseline}
    from temporalio.converter import JSONPlainPayloadConverter
    converter = JSONPlainPayloadConverter()
    hydrated = converter.from_payload(converter.to_payload(wrapped))
    assert hydrated == {'payment_request': baseline}
    assert type(hydrated) is dict and not hasattr(hydrated, 'operational_source')
    assert not hasattr(json.loads(json.dumps(wrapped)), 'operational_source')
    assert retain_operational_source(wrapped, {'safe': True}).operational_source is source
    class Foreign(BaseModel):
        image_url: str
    for invalid in (receipt, Foreign(image_url='private'), SimpleNamespace(operational_source=source)):
        try: project_operational_source(invalid, dom.model_visible_value)
        except TypeError: pass
        else: raise AssertionError('foreign/untyped source acquired operational authority')
    for field in ('unknown', 'write_lock_notification'):
        try: OperationalResult({}, field=field, source=source)
        except TypeError: pass
        else: raise AssertionError('foreign field acquired operational authority')
    assert type(retain_operational_source(SimpleNamespace(operational_source=source), {})) is dict
    unknown = {'image_url': secret, 'media': ['hidden'], 'text': quote(secret, safe='')}
    assert _project_declared(unknown, Any, dom.model_visible_value) == dom.model_visible_value(unknown)
    assert _project_declared(unknown, Any, dom.model_visible_value)['image_url'] != secret
    changed = copy.deepcopy(receipt)
    changed['line_items'][0]['image_url'] = 'https://images.example.test/' + quote(secret, safe='')
    changed['line_items'][0]['name'] = secret
    masked = project_operational_source(RequestPaymentCardBrowserTool.model_validate({'tool': action['action'], **changed}), dom.model_visible_value)
    assert secret not in json.dumps(masked) and quote(secret, safe='') not in json.dumps(masked)
    assert '{{secret:' in masked['line_items'][0]['name']
    assert 'image_url' in masked['line_items'][0]  # declared key, never page-controlled authority
    changed['line_items'][0]['image_url'] = 'data:image/png;base64,PRIVATE'
    data_view = project_operational_source(RequestPaymentCardBrowserTool.model_validate({'tool': action['action'], **changed}), dom.model_visible_value)
    assert data_view['line_items'][0]['image_url'] == dom.model_visible_value(changed['line_items'][0]['image_url'])
    assert dom.model_visible_value(masked['line_items'][0]['name']) == masked['line_items'][0]['name']
    assert 'operational_source' not in repr(wrapped)


async def test_notification_source_normalization_and_preview(m):
    from domains.spawn_browser_agent_v3 import handler as h
    from browser_tools.control_projection import project_operational_source
    from browser_tools.dom_service import DOMService
    action, fork = synthetic_purchase()
    # Exercise the actual notification producer, including its pre-mask schema validation.
    preview = png()
    fork['params']['media'] = []
    fork['params']['purchase']['items'][0].pop('image_url')
    async def response(**kwargs): return {'action': copy.deepcopy(fork), 'usage': {}}
    with patch.object(h, '_call_browser_use_with_rotation', AsyncMock(side_effect=response)):
        result = await h._generate_write_lock_notification(
            rose_client=None, task_prompt='Buy journals', dynamic_system_context='', browser_turn_messages=[],
            browser_state={'url': 'https://shop.example.test/checkout', 'screenshot': preview},
            action_entries=[], config=m._fake_config(), user_id='user-1', agent_id='agent-1', browser_task_id='task-1',
            iteration=1, token_state=h.ClaudeTokenState(), gpt_token=None, gpt_account_id=None,
            gpt_token_source=None, gpt_token_pool_id=None, browser_use_mode=None, approval_type='payment',
            current_url='https://shop.example.test/checkout', trusted_page_urls=['https://shop.example.test/checkout'],
            pending_action=action, write_lock_result={'status':'awaiting_payment_card_approval'},
            system_name='Rose', fallback_question='Approve?')
    assert result['notification']['media'][0]['kind'] == 'page_preview'
    assert result.operational_source.media[0].url == 'data:image/png;base64,' + preview
    dom = DOMService('ws://offline')
    assert project_operational_source(result.operational_source, dom.model_visible_value)['media'][0]['url'] == 'data:image/png;base64,' + preview
    dom.register_secret_refs({'pwd:fixture':'private'}); dom.mark_secret_used()
    safe = project_operational_source(result.operational_source, dom.model_visible_value)
    assert safe['media'][0]['url'].startswith('data:image/png;base64,')
    base64.b64decode(safe['media'][0]['url'].split(',', 1)[1], validate=True)
    assert not hasattr(json.loads(json.dumps(result)), 'operational_source')
