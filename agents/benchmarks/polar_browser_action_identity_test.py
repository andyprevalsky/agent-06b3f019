"""Native receipt identity survives private persistence and every Polar rubric."""
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import pytest

ROOT = Path(os.environ.get('R6_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
FIXTURE = Path(__file__).with_name('fixtures') / 'polar-bu020-source-step.json'


def activity():
    tree = ast.parse((ROOT/'agents/domains/spawn_browser_agent_v3/handler.py').read_text())
    return next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_spawn_browser_agent_activity_v3_real')


def compile_body(body, ns, name):
    function = ast.AsyncFunctionDef(name=name, args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]), body=body, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])), '<actual-receipt-boundary>', 'exec'), ns)
    return ns[name]


def polar():
    spec=importlib.util.spec_from_file_location('r6_polar', ROOT/'agents/benchmarks/polar_evaluator.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


async def execute_receipt(fixture, append=True, mask_number=False, restrict_navigation=False):
    from browser_tools.dom_service import ActionHistory
    from domains.spawn_browser_agent_v3 import handler
    from domains.spawn_browser_agent_v3.action_batch import BrowserActionBatch
    from domains.spawn_browser_agent_v3.navigation_policy import NavigationPolicyBarrier
    history=ActionHistory()
    history.restore_entries(fixture['prior_steps'])
    async def execute_action(*args, **kwargs):
        if append:
            await history.record_action(None, action=fixture['action'], params=fixture['params'], result=fixture['result'])
        return {**fixture['result'], 'action_step':999999}
    wrapper=next(n for n in ast.walk(activity()) if isinstance(n,ast.AsyncFunctionDef) and n.name=='_execute_action')
    from browser_tools.dom_service import DOMService
    policy=DOMService('ws://unused-wrapper-test')
    # Even a private value equal to the receipt number must not mask bookkeeping.
    policy.register_secret_refs({'cvv:test':'29'} if mask_number else {})
    body=copy.deepcopy(wrapper.body)
    body=[n for n in body if not isinstance(n,ast.Nonlocal)]
    identity={'target_id':'receipt-target','url':'https://example.com'}
    policy.get_parked_page_identity=lambda: dict(identity)
    navigation_policy=NavigationPolicyBarrier(fixture['task_id'])
    if restrict_navigation:
        navigation_policy.deny('receipt-session',identity)
    ns=dict(vars(handler))
    ns.update(action_history=history,execute_action=execute_action,args=(),
            kwargs={'action':{'action':fixture['action'],'params':fixture['params']}},
            secret_refs={'cvv:test':'29'} if mask_number else {},_auth_context_for_url=lambda _: {},
            current_url=identity['url'],dom_service=policy,
            navigation_policy=navigation_policy,policy_decision_tab=None,
            action_batch=BrowserActionBatch(lambda *_:None),session_id='receipt-session',
            task_id=fixture['task_id'],session_credential_ref=None,
            instruction_state={},schema_user_instruction_count=0,
            signed_in_realm_for_secret_refs=lambda *_:None,
            MINTED_NEW_PASSWORD_REF='pwd:minted')
    # Execute the current policy gate, with its real authority helpers. The
    # ordinary receipt fixture starts with an inactive policy and empty batch.
    helpers=[]
    for name in ('_credential_binding','_policy_authority','_policy_action_error'):
        node=copy.deepcopy(next(n for n in ast.walk(activity())
                                if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name))
        node.body=[ast.Global(names=n.names) if isinstance(n,ast.Nonlocal) else n for n in node.body]
        helpers.append(node)
    exec(compile(ast.fix_missing_locations(ast.Module(body=helpers,type_ignores=[])),
                 '<actual-policy-boundary>','exec'),ns)
    ns['policy_decision_authority']=ns['_policy_authority']()
    call=compile_body(body,ns,'run')
    return await call()


async def persist(fixture, result):
    from domains.spawn_browser_agent_v3 import handler
    from browser_tools.dom_service import ActionHistory, DOMService
    history=ActionHistory();policy=DOMService('ws://unused-receipt-test')
    policy.register_secret_refs({'pwd:test':'private-secret'})
    history.bind_dom_service(policy)
    captured=[]
    async def save(**kwargs):
        captured.append({'role':'TOOL','message':kwargs['message'],'metadata':{'toolName':'spawn_browser_agent','toolStatus':kwargs['status'],'task_id':kwargs['task_id'],**(kwargs.get('extra_metadata') or {})}})
    ns=dict(vars(handler));ns.update(action_history=history,write_lock_resume_state={'secret_redaction_refs':{'pwd:test':'private-secret'}},current_url='https://example.com',current_model='test',browser_pool='test',save_browser_action_message=save)
    owners=[n for n in activity().body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in {'_redact_activity_value','_save_browser_action_message'}]
    exec(compile(ast.fix_missing_locations(ast.Module(body=owners,type_ignores=[])),'<actual-private-owner>','exec'),ns)
    success=next(n for n in ast.walk(activity()) if isinstance(n,ast.If) and ast.unparse(n.test)=="result.get('success', True)" and any(isinstance(v,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='extra_metadata' for t in v.targets) for v in n.body))
    start=next(i for i,n in enumerate(success.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='extra_metadata' for t in n.targets))
    end=next(i for i,n in enumerate(success.body[start:],start) if isinstance(n,ast.Expr) and isinstance(n.value,ast.Await) and isinstance(n.value.value,ast.Call) and getattr(n.value.value.func,'id',None)=='_save_browser_action_message')
    ns.update(result=result,unified_action={'action':fixture['action'],'params':fixture['params']},action_name=fixture['action'],auth_runtime_state=SimpleNamespace(mark_credential_ref=lambda _:None),agent_id=fixture['agent_id'],title_done='evaluate',task_id=fixture['task_id'],MessageStatus=SimpleNamespace(FINISHED='FINISHED'),browser_url='',tool_call_id_action='receipt',iteration=21,MAX_ITERATIONS=100,coords_for_cursor=None)
    await compile_body(success.body[start:end+1],ns,'persist')()
    return captured[0]


@pytest.mark.asyncio
@pytest.mark.parametrize('mask_number', [False, True])
async def test_polar_browser_original_receipt_reaches_every_judge_without_regrading(mask_number):
    f=json.loads(FIXTURE.read_text());result=await execute_receipt(f,mask_number=mask_number)
    assert result['action_step']==29
    row=await persist(f,result)
    assert row['metadata'].get('browser_action_step')==29, 'Native receipt identity disappeared during persistence'
    messages=copy.deepcopy(f['messages']);messages[-1]=row
    requests=[]
    async def judge(messages,**kwargs):
        requests.append(messages[1]['content'][0]['text']);return 'Thoughts: evidence transport only.\nStatus: failure'
    outcome=await polar().run_polar_evaluator(task_prompt='Complete the form and validate submission.',evaluator={'criteria':['Task','Output','No fabrication']},data={'messages':messages},judge_llm=judge)
    label=f"Recorded browser task {f['task_id']}: action-history step 29"
    assert len(requests)==3 and all(label in r for r in requests)
    original,_=polar().build_polar_trajectory({'messages':f['messages']})
    revised,_=polar().build_polar_trajectory({'messages':messages})
    assert '83.' in original and '83.' in revised
    assert revised.index('United States') < revised.index(label)
    assert outcome['perfect'] is False and outcome['score']==0.0


@pytest.mark.asyncio
async def test_polar_browser_unrecorded_result_cannot_forge_native_identity():
    f=json.loads(FIXTURE.read_text())
    result=await execute_receipt(f,append=False)
    assert 'action_step' not in result, 'Unrecorded result supplied a forged receipt identity'
    row=await persist(f,result)
    assert 'browser_action_step' not in row['metadata']


@pytest.mark.asyncio
async def test_polar_browser_identity_is_scoped_and_content_stays_private():
    f=json.loads(FIXTURE.read_text());f['params']={'code':"fetch('/?key=private-secret')"}
    row=await persist(f,await execute_receipt(f))
    assert 'private-secret' not in json.dumps(row)
    assert 'pwd:test' in json.dumps(row)
    other=copy.deepcopy(row);other['metadata']['task_id']='another-browser-task'
    text,_=polar().build_polar_trajectory({'messages':[row,other]})
    assert f"Recorded browser task {f['task_id']}: action-history step 29" in text
    assert 'Recorded browser task another-browser-task: action-history step 29' in text
    for invalid in (None,True,-1,'29'):
        invalid_row=copy.deepcopy(row);invalid_row['metadata']['browser_action_step']=invalid
        text,_=polar().build_polar_trajectory({'messages':[invalid_row]})
        assert 'action-history step' not in text
    from helpers.llm import convert_context_to_messages
    before=convert_context_to_messages([row]);row['metadata']={}
    assert before==convert_context_to_messages([row])


@pytest.mark.asyncio
async def test_polar_browser_active_policy_cannot_mint_receipt_identity():
    from domains.spawn_browser_agent_v3.navigation_policy import NavigationPolicyBarrier
    f=json.loads(FIXTURE.read_text())
    result=await execute_receipt(f,restrict_navigation=True)
    assert result == {'success':False,'error':NavigationPolicyBarrier.feedback}
    assert 'action_step' not in result
