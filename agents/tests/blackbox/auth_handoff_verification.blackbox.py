"""Offline mechanism proof at the actual browser activity; no semantic-model proof."""
import importlib.util
from pathlib import Path
from unittest.mock import AsyncMock, patch
from _test_utils import BlackboxResult
from otp_retry_behavior import _offline_activity_edges
from auth_assessment_behavior import assessment, handoff, INVENTORY

async def test_terminal_handoff_receives_independent_review():
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('semantic_handoff_fixture',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    first=assessment(blocker='user_only_verification',reason='The supplied profile identity must own this generic code challenge; other identities cannot satisfy the goal.')
    final=assessment(blocker='user_only_verification',reason='A named-account password has been accepted and approval on its separate device is required.')
    r={'inventory':INVENTORY,'goal':'Open the user URL and identify the member number, using saved sessions or agent identity if applicable.','actions':[handoff(first),handoff(final)]}
    judge=AsyncMock(side_effect=[{'score':0,'reasoning':'The generic challenge and identity ownership do not establish site registration or a goal restriction.','usage':{}},{'score':1,'reasoning':'The accepted named account requires its approval device.','usage':{}}])
    with _offline_activity_edges(),patch('helpers.llm.check_progress',judge):
        await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r)
    assert judge.await_count==2,'real browser activity committed an unreviewed handoff'
    assert len(r['contexts'])==2 and not r.get('executed'),'review must return ordinary control, never auto-select an identity'
    assert 'authentication_handoff_unverified'in str(r['contexts'][1]['turn_messages'])
    reviewed_context = judge.await_args_list[0].args[0]
    assert reviewed_context[0]['text'].startswith('Goal: Verify whether transferring')
    assert 'Original browser task:' in reviewed_context[0]['text']
    for context in r['contexts']:
        pending=set()
        for message in context['turn_messages']:
            if message.get('role')=='assistant':
                pending.update(c['id'] for c in message.get('tool_calls',[]))
            if message.get('role')=='tool':
                assert message['tool_call_id'] in pending
                pending.remove(message['tool_call_id'])
        assert not pending, 'retained decision history must be protocol-valid'


async def test_supported_human_control_transfers():
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('semantic_handoff_positives',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    for label,reason in [
        ('named_account','The user explicitly requires named@example.test only.'),
        ('app_approval','The named account password was accepted and a separate-device approval is required.'),
        ('account_locked','The observed required account is locked.'),
        ('unreadable','The required established account channel is unreadable by available runtime capabilities.'),
    ]:
        a=assessment(phone='unavailable',blocker='user_only_verification',reason=reason)
        r={'inventory':INVENTORY,'goal':reason,'actions':[handoff(a)]}
        judge=AsyncMock(return_value={'score':1,'reasoning':reason,'usage':{}})
        with _offline_activity_edges(),patch('helpers.llm.check_progress',judge):
            await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r)
        assert judge.await_count==1 and r['result']['status']=='awaiting_auth_assistance',label
        assert not r.get('executed'), 'verification must not select another identity'

async def test_unavailable_review_consumes_existing_budget():
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('semantic_handoff_budget',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    from domains.spawn_browser_agent_v3.config import MAX_ITERATIONS
    assert MAX_ITERATIONS==250
    r={'inventory':INVENTORY,'actions':[handoff(assessment())],'expected_status':'max_iterations'}
    async def unavailable(*args, **kwargs):
        if len(args)>5 and args[5]=='verifier_browser_auth_handoff':
            raise RuntimeError('review unavailable')
        return {'score':0,'reasoning':'Not completed','usage':{}}
    judge=AsyncMock(side_effect=unavailable)
    with _offline_activity_edges(),patch('helpers.llm.check_progress',judge):
        await module.test_auth_handoff_consumes_otp_received_during_decision('empty',resume_step_count=MAX_ITERATIONS-1,auth_review=r)
    assert sum(len(c.args)>5 and c.args[5]=='verifier_browser_auth_handoff' for c in judge.await_args_list)==3
    assert len(r['contexts'])==1 and not r.get('executed')

async def test_synthetic_soft_complete_is_not_handoff_evidence():
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('semantic_soft_complete',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    r={'inventory':INVENTORY,'actions':[handoff(assessment()),handoff(assessment())]}
    judge=AsyncMock(side_effect=[
        {'score':1.0,'reasoning':'Synthetic fast mode soft pass','usage':{'actual_model':'fast-mode-soft-complete','from_fast_cache':True}},
        {'score':1.0,'reasoning':'Real cached judge verdict supports human approval','usage':{'actual_model':'rose-labs/rose-1-ultra','from_fast_cache':True}},
    ])
    with _offline_activity_edges(),patch('helpers.llm.check_progress',judge):
        await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r)
    assert judge.await_count==2 and len(r['contexts'])==2
    assert not r.get('executed'), 'neither rejection nor a cached verdict chooses an identity'

async def test_fresh_redirect_invalidates_proposal_before_judging():
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('semantic_redirect',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    r={'inventory':INVENTORY,'actions':[handoff(assessment()),handoff(assessment())],
       'observed_states':[{'url':'https://different.example/new-realm','dom_tree':'A different page'}, {'url':'https://shop.example/login/verify','dom_tree':'Returned to the assessed challenge'}]}
    judge=AsyncMock(return_value={'score':1.0,'reasoning':'Current observed challenge supports human approval','usage':{}})
    with _offline_activity_edges(),patch('helpers.llm.check_progress',judge):
        await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r)
    assert len(r['contexts'])==2 and judge.await_count==1, 'stale realm inventory must not reach the judge or handoff'
    assert 'authentication_handoff_page_changed' in str(r['contexts'][1]['turn_messages'])

async def run_all_tests():
    result=BlackboxResult()
    await result.record_async('independent handoff review before pausing',test_terminal_handoff_receives_independent_review)
    await result.record_async('supported user-only transfers',test_supported_human_control_transfers)
    await result.record_async('ordinary250budget and error cleanup',test_unavailable_review_consumes_existing_budget)
    await result.record_async('synthetic soft-complete rejected, real cached verdict retained',test_synthetic_soft_complete_is_not_handoff_evidence)
    await result.record_async('fresh redirect re-enters ordinary planning',test_fresh_redirect_invalidates_proposal_before_judging)
    return result.summary()
