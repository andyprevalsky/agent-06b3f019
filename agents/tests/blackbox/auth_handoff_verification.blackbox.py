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


def test_handoff_receives_existing_planner_otp_contract():
    from copy import deepcopy
    from providers.rose.browser_use import build_browser_use_system_prompt
    from domains.spawn_browser_agent_v3.handoff_verification import build_auth_handoff_verifier_context
    planner = build_browser_use_system_prompt([])
    expected = next(line[2:] for line in planner.splitlines()
                    if line.startswith('- OTP codes from email or SMS '))
    assert 'another 60 seconds' in expected and 'resend' in expected
    for restriction in [
        'The user explicitly requires named@example.test only.',
        'The accepted account requires approval on its separate device.',
        'The observed required account is locked.',
        'The required established account channel is unreadable.',
        'The current permitted channel has no admitted code after the observed waits.',
    ]:
        context = [{'role': 'USER', 'text': restriction}, {'role': 'TOOL', 'text': 'Actual observations remain unchanged'}]
        proposal = {'reason': restriction, 'recipient_options': []}
        original_context, original_proposal, original_inventory = deepcopy(context), deepcopy(proposal), deepcopy(INVENTORY)
        actual = build_auth_handoff_verifier_context(context, auth_options=INVENTORY, assessment=proposal)
        assert expected in actual[-1]['text'], 'handoff judge omitted the authoritative planner OTP contract'
        assert actual[-1]['text'].count(expected) == 1
        assert actual[:-1] == context == original_context
        assert proposal == original_proposal and INVENTORY == original_inventory
        assert actual[-1]['role'] == 'USER'
        assert not any('tool_calls' in message for message in actual), 'shared policy must not execute or choose an identity'

async def test_input_arriving_during_handoff_review_replans(kind="otp"):
    from datetime import datetime, timezone, timedelta
    from copy import deepcopy
    from _test_utils import native_browser_start_source
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('handoff_late_input',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    arrived=False
    now=datetime.now(timezone.utc)
    rows=[await native_browser_start_source((now-timedelta(minutes=1)).isoformat())]
    a=assessment(blocker='user_only_verification',reason='The required established account needs user assistance.')
    r={'inventory':INVENTORY,'actions':[handoff(a),handoff(a)]}
    async def emails(*args, **kwargs):
        if arrived and kind=='user_during_poll' and not any(row.get('id')=='actual-new-user-row' for row in rows):
            rows.append({'id':'actual-new-user-row','role':'USER','text':'Use the explicitly named account only.',
                         'timestamp':datetime.now(timezone.utc).isoformat(),'metadata':{'source':'sms_supervisor'}})
        if not arrived or kind!='otp': return []
        return [{'id':'late-owned-message','credentialId':'late-owned-inbox','date':datetime.now(timezone.utc).isoformat(),
                 'from':'Fixture Shop','subject':'Verification','bodyText':'Your verification code is 847291'}]
    r['fetch_emails']=emails
    async def judge_result(*args, **kwargs):
        nonlocal arrived
        if not arrived:
            arrived=True
            if kind=='user_instruction':
                rows.append({'id':'actual-new-user-row','role':'USER','text':'Use the explicitly named account only.',
                             'timestamp':datetime.now(timezone.utc).isoformat(),'metadata':{'source':'sms_supervisor'}})
        return {'score':1.0,'reasoning':'Scripted verdict for the snapshot judged','usage':{}}
    judge=AsyncMock(side_effect=judge_result)
    async def poll(*args, **kwargs): return deepcopy(rows)
    r['poll_user_messages']=poll
    schema={'fields':[{'name':'result','type':'string'}]}
    with _offline_activity_edges(),patch('helpers.llm.check_progress',judge), \
         patch('domains.spawn_browser_agent_v3.handler.poll_new_messages',poll), \
         patch('helpers.llm._generate_response_schema_with_rose',AsyncMock(return_value=(schema,None,{}))):
        await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r)
    assert judge.await_count==2, 'handoff committed a verdict after real input changed during its await'
    assert len(r['contexts'])==2 and not r.get('executed'), 'new input must replan without automatic typing'
    turns=str(r['contexts'][1]['turn_messages'])
    assert ('847291' in turns) if kind=='otp' else ('Use the explicitly named account only.' in turns)

async def test_handoff_post_review_input_errors_remain_typed(kind='unavailable'):
    from datetime import datetime, timezone, timedelta
    from _test_utils import native_browser_start_source
    from helpers.workflow_generation import WorkflowGenerationSealed
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('handoff_input_errors',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    rows=[await native_browser_start_source((datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat())]
    reviewed=False
    async def poll(*args, **kwargs):
        if reviewed:
            if kind=='sealed': raise WorkflowGenerationSealed('fixture input generation sealed')
            raise TimeoutError('fixture durable input unavailable')
        return rows
    async def verdict(*args, **kwargs):
        nonlocal reviewed
        reviewed=True
        return {'score':1.0,'reasoning':'Scripted review of prior input snapshot','usage':{}}
    r={'inventory':INVENTORY,'actions':[handoff(assessment())], 'expected_status':'failed','poll_user_messages':poll}
    with _offline_activity_edges(),patch('helpers.llm.check_progress',AsyncMock(side_effect=verdict)):
        if kind=='sealed':
            try:
                await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r)
            except WorkflowGenerationSealed:
                pass
            else:
                assert False, 'generation seal at post-review input boundary was swallowed'
        else:
            await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r)
            assert r['result']['browser_error_type']=='TimeoutError'
            assert not r.get('executed')

def test_handoff_uses_model_visible_owned_bindings():
    import ast, inspect, textwrap
    from copy import deepcopy
    from browser_tools.dom_service import ActionHistory, DOMService
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.auth_assessment import auth_recipient_options
    tree=ast.parse(textwrap.dedent(inspect.getsource(handler._spawn_browser_agent_activity_v3_real)))
    calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='auth_assistance_assessment_result']
    assert len(calls)==1
    expression=compile(ast.fix_missing_locations(ast.Expression(calls[0])),'<actual-assessment-call>','eval')
    for private in (False,True):
        realm='owned.fixture.test';url='https://owned.fixture.test/verify?binding=private-binding'
        email='owned-private@example.test'
        policy=DOMService('ws://unused-assessment-binding')
        if private: policy.register_secret_refs({'realm':'owned','binding':'private-binding','recipient':email})
        inventory={'email_otp':{'available':True,'connected_emails':[email]}}
        history=ActionHistory();history.bind_dom_service(policy)
        history.restore_entries([{'step':2,'action':'input_text','params':{'text':email},'result':{'success':True}},
                                 {'step':3,'action':'read_browser_state','result':{'current_url':url}}])
        proposal={'auth_realm':policy.model_visible_value(realm),'page_url':policy.model_visible_value(url),
                  'blocker':'automated_options_exhausted','reason':'Observed recipient-specific rejection',
                  'recipient_options':[{'method':'email_otp','recipient':policy.model_visible_value(email),
                    'status':'exhausted','evidence':'The entered recipient was rejected','evidence_steps':[2,3]}]}
        namespace=dict(vars(handler),unified_action={'params':{'auth_assessment':proposal}},auth_options=inventory,
                       auth_realm=realm,current_url=url,action_history=history,dom_service=policy)
        assert eval(expression,namespace) is None, 'same native page/inventory becomes unusable after private projection'
        for mutate in (lambda a:a.update(page_url='https://foreign.fixture.test/verify'),
                       lambda a:a.update(auth_realm='stale.fixture.test'),
                       lambda a:a['recipient_options'][0].update(recipient='foreign@example.test'),
                       lambda a:a['recipient_options'][0].update(evidence_steps=[999])):
            foreign=deepcopy(proposal);mutate(foreign);namespace['unified_action']={'params':{'auth_assessment':foreign}}
            assert eval(expression,namespace) is not None, 'foreign or stale public binding was accepted'
        namespace['unified_action']={'params':{'auth_assessment':proposal}}
        if private:
            collision=deepcopy(inventory);collision['email_otp']['connected_emails'].append(policy.model_visible_value(email))
            namespace['auth_options']=collision
            assert eval(expression,namespace) is not None, 'colliding public identities lost complete recipient accounting'
            namespace['auth_options']=inventory
        from unittest.mock import patch
        original_projection = policy.model_visible_value
        with patch.object(policy,'model_visible_value',side_effect=lambda value: '' if isinstance(value,str) else original_projection(value)):
            assert eval(expression,namespace) is not None, 'removed identity bindings must fail closed'

async def test_handoff_private_native_page_binding():
    from browser_tools.dom_service import DOMService
    path=Path(__file__).with_name('spawn_browser_agent_v3.blackbox.py')
    spec=importlib.util.spec_from_file_location('private_native_binding',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    for private, drift in ((False,False),(True,False),(True,True)):
        raw='https://shop.example/login/verify?binding=private-binding'
        policy=DOMService('ws://unused-binding')
        refs={'binding':'private-binding'} if private else {}
        policy.register_secret_refs(refs)
        public=policy.model_visible_value(raw)
        proposal={'auth_realm':'shop.example','page_url':public,'blocker':'user_only_verification',
                  'reason':'Observed app approval requires the user','recipient_options':[]}
        states=[{'url':public}]
        actions=[handoff(proposal)]
        if drift:
            # Identical public URL, distinct actual native URL: public equality alone is unsafe.
            states=[{'url':public,'_native_url':public}]
        r={'inventory':{'auth_realm':'shop.example'},'actions':actions,'native_url':raw,'public_url':public,
           'resume_state':{'secret_redaction_refs':refs},'observed_states':states}
        if drift: r['expected_status']='max_iterations'
        judge=AsyncMock(return_value={'score':1.0,'reasoning':'Scripted observed app approval','usage':{}})
        with _offline_activity_edges(),patch('helpers.llm.check_progress',judge):
            await module.test_auth_handoff_consumes_otp_received_during_decision('empty',auth_review=r,resume_step_count=249 if drift else 0)
        assert sum(len(call.args)>5 and call.args[5]=='verifier_browser_auth_handoff' for call in judge.await_args_list)==(0 if drift else 1)
        assert len(r['contexts'])==1
        assert not r.get('executed')
        if drift:
            assert not r['auth_calls'], 'public collision must not authorize native page drift'
        else:
            assert r['auth_calls'][0].kwargs['current_url']==public, 'existing attention payload redaction must remain intact'

async def test_rebound_public_recipient_receipts_fail_closed():
    from browser_tools.dom_service import DOMService, ActionHistory
    from domains.spawn_browser_agent_v3.auth_assessment import auth_assistance_assessment_result
    import ast,inspect,textwrap
    from domains.spawn_browser_agent_v3 import handler
    tree=ast.parse(textwrap.dedent(inspect.getsource(handler._spawn_browser_agent_activity_v3_real)))
    call=next(n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='auth_assistance_assessment_result')
    expression=compile(ast.fix_missing_locations(ast.Expression(call)),'<actual-rotation-assessment>','eval')
    for rotate, realm_rotates in ((False,False),(True,False),(True,True)):
        policy=DOMService('ws://unused-rotation')
        old='old@example.test';current='new@example.test' if rotate else old
        policy.register_secret_refs({'recipient':old, 'realm':'old-owned.test'})
        history=ActionHistory()
        await history.record_action(policy,action='input_text',params={'text':'{{secret:recipient}}'})
        await history.record_action(policy,action='read_browser_state',result={'current_url':'https://owned.test/verify'})
        if rotate:
            policy.register_secret_refs({'recipient':current,'realm':'new-owned.test' if realm_rotates else 'old-owned.test'})
        realm='new-owned.test' if realm_rotates else 'old-owned.test'
        proposal={'auth_realm':policy.model_visible_value(realm),'page_url':'https://owned.test/verify',
                  'blocker':'automated_options_exhausted','reason':'Observed recipient rejection',
                  'recipient_options':[{'method':'email_otp','recipient':policy.model_visible_value(current),
                    'status':'exhausted','evidence':'Recipient rejected','evidence_steps':[1,2]}]}
        entries=history.get_entries()
        assert [entry['step'] for entry in entries]==[1,2]
        result=eval(expression,dict(vars(handler),unified_action={'params':{'auth_assessment':proposal}},auth_options={'email_otp':{'available':True,'connected_emails':[current]}},auth_realm=realm,current_url='https://owned.test/verify',action_history=history,dom_service=policy))
        assert (result is None)==(not rotate), 'old public receipt was relabeled as the newly bound identity'
        if not realm_rotates:
            for disposition in ('not_applicable', 'unavailable'):
                proposal['recipient_options'][0]['status']=disposition
                proposal['attempted_recipient_options']=[{'method':'email_otp','recipient':policy.model_visible_value(current),'evidence_steps':[1,2]}]
                result=eval(expression,dict(vars(handler),unified_action={'params':{'auth_assessment':proposal}},auth_options={'email_otp':{'available':True,'connected_emails':[current]}},auth_realm=realm,current_url='https://owned.test/verify',action_history=history,dom_service=policy))
                assert (result is None)==(not rotate), 'past attempt certified the rebound identity through a non-exhausted row'



def test_handoff_receives_complete_actor_authentication_contract():
    from copy import deepcopy
    from browser_tools.schemas import AVAILABLE_ACTIONS
    from providers.rose.browser_use import build_browser_use_system_prompt
    from domains.spawn_browser_agent_v3.handoff_verification import build_auth_handoff_verifier_context
    from unittest.mock import patch
    for flag in ('0', '1', 'true', 'yes', 'on', 'false'):
        with patch.dict('os.environ', {'BROWSER_DISABLE_RECOVER_FROM_CHALLENGE': flag}):
            planner = build_browser_use_system_prompt(AVAILABLE_ACTIONS)
            expected = '# Authentication\n' + planner.split('# Authentication\n', 1)[1]
            for restriction in ('Use only the explicitly named account.', 'The accepted account needs its approval device.', 'The required account is locked.', 'The established channel is unreadable.', 'No authorized automation remains available; registration is unknown.'):
                context = [{'role': 'USER', 'text': restriction}, {'role': 'TOOL', 'text': 'Actual observed state'}]
                proposal = {'reason': restriction, 'recipient_options': []}
                old = deepcopy((context, proposal, INVENTORY))
                actual = build_auth_handoff_verifier_context(context, auth_options=INVENTORY, assessment=proposal)
                assert expected in actual[-1]['text'], 'handoff judge omitted the complete authoritative actor Authentication contract'
                assert actual[-1]['text'].count(expected) == 1
                assert (context, proposal, INVENTORY) == old
                assert actual[:-1] == context
                assert actual[-1]['role'] == 'USER'
                assert not any('tool_calls' in message for message in actual)

async def run_all_tests():
    result=BlackboxResult()
    result.record("complete actor Authentication contract at independent handoff consumer", test_handoff_receives_complete_actor_authentication_contract)
    await result.record_async("rebound public alias receipts fail closed",test_rebound_public_recipient_receipts_fail_closed)
    await result.record_async("private native page binding and public collision drift",test_handoff_private_native_page_binding)
    result.record("private and public handoff binding parity",test_handoff_uses_model_visible_owned_bindings)
    await result.record_async("USER arriving during final inbox drain invalidates verdict",lambda: test_input_arriving_during_handoff_review_replans("user_during_poll"))
    await result.record_async("post-review durable input outage remains failed",test_handoff_post_review_input_errors_remain_typed)
    await result.record_async("post-review generation seal propagates",lambda: test_handoff_post_review_input_errors_remain_typed("sealed"))
    await result.record_async("handoff verdict freshness against newly admitted OTP",test_input_arriving_during_handoff_review_replans)
    await result.record_async("handoff verdict freshness against new USER instruction",lambda: test_input_arriving_during_handoff_review_replans("user_instruction"))
    result.record("shared existing planner OTP contract at handoff consumer", test_handoff_receives_existing_planner_otp_contract)
    await result.record_async('independent handoff review before pausing',test_terminal_handoff_receives_independent_review)
    await result.record_async('supported user-only transfers',test_supported_human_control_transfers)
    await result.record_async('ordinary250budget and error cleanup',test_unavailable_review_consumes_existing_budget)
    await result.record_async('synthetic soft-complete rejected, real cached verdict retained',test_synthetic_soft_complete_is_not_handoff_evidence)
    await result.record_async('fresh redirect re-enters ordinary planning',test_fresh_redirect_invalidates_proposal_before_judging)
    return result.summary()
