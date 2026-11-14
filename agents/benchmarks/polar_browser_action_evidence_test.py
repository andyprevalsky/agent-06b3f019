"""Actual browser persistence -> Polar judge evidence, without grading task success."""
import ast
import importlib.util
import json
import os
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(os.environ.get('R3_SOURCE_ROOT', Path(__file__).resolve().parents[2]))
FIXTURE = Path(__file__).with_name('fixtures') / 'polar-bu022-executed-filter.json'


@pytest.mark.asyncio
async def test_polar_browser_executed_filter_inputs_survive_actual_persistence():
    fixture = json.loads(FIXTURE.read_text())
    handler = ROOT / 'agents/domains/spawn_browser_agent_v3/handler.py'
    tree = ast.parse(handler.read_text())
    function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_spawn_browser_agent_activity_v3_real')
    success = next(n for n in ast.walk(function) if isinstance(n, ast.If) and ast.unparse(n.test) == "result.get('success', True)" and any(isinstance(v, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'extra_metadata' for t in v.targets) for v in n.body))
    start = next(i for i,n in enumerate(success.body) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'extra_metadata' for t in n.targets))
    end = next(i for i,n in enumerate(success.body[start:],start) if isinstance(n, ast.Expr) and isinstance(n.value, ast.Await) and isinstance(n.value.value, ast.Call) and isinstance(n.value.value.func,ast.Name) and n.value.value.func.id=='_save_browser_action_message')
    captured=[]
    async def save(**kwargs):
        captured.append({'role':'TOOL','message':kwargs['message'],'metadata':{'toolName':'spawn_browser_agent','toolStatus':kwargs['status'],**(kwargs['extra_metadata'] or {})}})
    module=ast.fix_missing_locations(ast.Module(body=[ast.AsyncFunctionDef(name='persist',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=success.body[start:end+1],decorator_list=[])],type_ignores=[]))
    namespace=dict(result=fixture['result'],unified_action=fixture['action'],action_name='evaluate',auth_runtime_state=SimpleNamespace(mark_credential_ref=lambda _:None),_save_browser_action_message=save,agent_id='fixture-root',title_done='evaluate',task_id='fixture-task',MessageStatus=SimpleNamespace(FINISHED='FINISHED'),browser_url='',tool_call_id_action='executed-filter',iteration=31,MAX_ITERATIONS=100,coords_for_cursor=None)
    exec(compile(module,'<actual-success-persistence>','exec'),namespace)
    await namespace['persist']()
    spec=importlib.util.spec_from_file_location('r3_polar',ROOT/'agents/benchmarks/polar_evaluator.py');polar=importlib.util.module_from_spec(spec);spec.loader.exec_module(polar)
    requests=[]
    async def judge(messages,**kwargs):
        requests.append(messages[1]['content'][0]['text'])
        return 'Thoughts: transport control only, no outcome judged.\nStatus: failure'
    result=await polar.run_polar_evaluator(task_prompt='Use advanced search to filter movies released in 2022.',evaluator={'criteria':['End-to-end task','Output','No fabrication']},data={'messages':captured},judge_llm=judge)
    code=fixture['action']['params']['code']
    assert len(requests)==3
    assert all(code in text.replace('\\"','"') or json.dumps(fixture['action']['params'],ensure_ascii=False,sort_keys=True) in text for text in requests), 'Executed filter parameters disappeared before Polar judge'
    assert result['perfect'] is False and result['score']==0.0


@pytest.mark.asyncio
async def test_polar_keeps_recorded_native_observation_without_claiming_success():
    fixture=json.loads(FIXTURE.read_text());spec=importlib.util.spec_from_file_location('r3_polar_observation',ROOT/'agents/benchmarks/polar_evaluator.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
    row=fixture['observation_message'];text,images=p.build_polar_trajectory({'messages':[row]})
    assert row['metadata']['browser_observation'] in text, 'Native observation was omitted from full action history'
    assert images==[]


@pytest.mark.asyncio
async def test_polar_browser_params_use_existing_private_persistence_owner():
    from domains.spawn_browser_agent_v3 import handler
    from browser_tools.dom_service import ActionHistory, DOMService
    from domains.spawn_browser_agent_v3.service_crypto import mask_secret_values
    from helpers.llm import convert_context_to_messages
    tree=ast.parse((ROOT/'agents/domains/spawn_browser_agent_v3/handler.py').read_text())
    activity=next(n for n in tree.body if isinstance(n,ast.AsyncFunctionDef) and n.name=='_spawn_browser_agent_activity_v3_real')
    owners=[n for n in activity.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in {'_redact_activity_value','_save_browser_action_message'}]
    assert len(owners)==2
    policy=DOMService('ws://unused-private-persistence')
    policy.register_secret_refs({'pwd:synthetic':'private-secret'})
    history=ActionHistory();history.bind_dom_service(policy)
    captured=[]
    async def save(**kwargs):captured.append(kwargs)
    ns=dict(vars(handler));ns.update(action_history=history,write_lock_resume_state={'secret_redaction_refs':{'pwd:synthetic':'private-secret'}},current_url='https://example.com/results?token=private-query',current_model='fixture-model',browser_pool='rose-1-ultra',save_browser_action_message=save)
    exec(compile(ast.fix_missing_locations(ast.Module(body=owners,type_ignores=[])),'<actual-private-persistence-owner>','exec'),ns)
    await ns['_save_browser_action_message'](message='result',extra_metadata={'browser_action_params':{'code':"fetch('/search?q=2022&key=private-secret')"}},auxiliary={})
    safe=captured[0]['extra_metadata']['browser_action_params']
    assert 'private-secret' not in json.dumps(captured)
    assert 'pwd:synthetic' in safe['code']
    assert '2022' in safe['code']
    row={'role':'TOOL','text':'result','metadata':captured[0]['extra_metadata']}
    before=convert_context_to_messages([row]);row['metadata']={}
    assert before==convert_context_to_messages([row]), 'Evidence metadata must not duplicate action code into parent planning'
