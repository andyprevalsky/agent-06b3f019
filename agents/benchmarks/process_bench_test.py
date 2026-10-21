"""Process Bench acceptance controls, registered in the benchmark blackbox domain."""

from benchmarks.process_bench import compile_evaluators, validate_process


def test_process_spec_rejects_empty_steps():
    try:
        validate_process({"version": 1, "steps": []})
    except ValueError:
        return
    raise AssertionError("An empty process cannot be executable")


def test_process_generation_is_deterministic():
    from benchmarks.benchmark_tasks import get_tasks_by_tag

    tasks = get_tasks_by_tag("process")
    assert len(tasks) == 10
    for task in tasks:
        assert compile_evaluators(task.process_spec) == task.evaluators


import asyncio
import copy
import hashlib
import importlib.util
import json
import shlex
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from benchmarks.process_bench import ASSETS, FIXTURE_PATH, check_process_trace, validate_task_process


def _task(name='purchase-approval'):
    from benchmarks.benchmark_tasks import get_task_by_name
    return copy.deepcopy(get_task_by_name('process-' + name))


def _trace(task):
    """Execute the real fixture and package its stdout as native Codex events.

    This is deterministic provider-boundary proof, not a claimed live LLM run.
    """
    module_spec = importlib.util.spec_from_file_location('process_fixture', ASSETS / 'process-fixture.py')
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    fixture_path = ASSETS / 'process-fixtures.json'
    fingerprint = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
    outcomes = json.loads(fixture_path.read_text())[task.process_spec['case']]
    events=[]
    with tempfile.TemporaryDirectory() as directory:
        for step in task.process_spec['steps']:
            condition = step.get('when')
            if condition:
                source = next(s for s in task.process_spec['steps'] if s['id'] == condition['step'])
                if outcomes[source['action']][condition['field']] != condition['equals']:
                    continue
            samples = json.loads(Path(__file__).with_name('fixtures').joinpath('process-positive-inputs.json').read_text())
            data = {k: (samples[task.process_spec['case']][step['id']][k] if values == ['*'] else values[0]) for k, values in step['inputs'].items()}
            args = [task.process_spec['case'],step['action'],step['actor'],step['entity'],str(step['day']),json.dumps(data),fingerprint]
            receipt = module.execute(*args, fixture_path=fixture_path, output_dir=Path(directory))
            events.append(dict(type='command',status='completed',command=shlex.join(['python3', FIXTURE_PATH,*args]), output=json.dumps(receipt),exit_code=0))
    native_events=[]
    for event in events:
        native_events.extend([dict(type='command',status='started',command=event['command']),event])
    events=native_events
    row = dict(role='TOOL',message='Code-agent SDK event JSON:\n\n'+json.dumps({'code_agent_events':events}),metadata=dict(toolName='code_agent_sdk_events',toolStatus='FINISHED',task_id='fixture-session'))
    data = dict(agent=dict(agent_id='root',status='COMPLETED',progress=1.0),messages=[dict(role='ASSISTANT',message='Everything is perfectly complete.')],_semantic_evaluator_tree={'root':dict(parent_agent_id=None,messages=[]),'child':dict(parent_agent_id='root',messages=[row])},_benchmark={})
    return data


def _events(data):
    row = data['_semantic_evaluator_tree']['child']['messages'][0]
    events=json.loads(row['message'].split('\n\n',1)[1])['code_agent_events']
    return row, [event for event in events if event.get('status') != 'started']


def _store(row, events):
    if all(e.get('type')=='command' and e.get('status')=='completed' for e in events):
        events=[item for e in events for item in (dict(type='command',status='started',command=e['command']),e)]
    row['message']='Code-agent SDK event JSON:\n\n'+json.dumps({'code_agent_events':events})


def test_all_ten_real_fixture_traces_pass_and_select():
    from benchmarks.benchmark_tasks import get_tasks_by_tag
    from benchmarks.long_horizon import validate_catalog
    from argparse import Namespace
    from benchmarks.run_benchmark import resolve_tasks
    assert len(resolve_tasks(Namespace(task=None, suite='process', prod=False, exclude_task=[]))) == 10
    assert len([t for t in validate_catalog() if 'process' in t['tags']]) == 10
    tasks=get_tasks_by_tag('process')
    assert {t.name for t in tasks} == {t.name for t in get_tasks_by_tag('process-bench')}
    for task in tasks:
        passed,reason=check_process_trace(task.process_spec,_trace(task))
        assert passed,(task.name,reason)
        assert task.name.startswith('process-') and task.enforce_declared_evaluators


@pytest.mark.parametrize('mutation', ['missing-prerequisite','out-of-order','wrong-entity','wrong-actor','fabricated','unproven-branch','premature-success','shortcut','bad-input','altered-result','backwards-clock'])
def test_process_adversarial_traces_fail_even_with_successful_summary(mutation):
    task=_task();data=_trace(task);row,events=_events(data)
    if mutation=='missing-prerequisite': events.pop(1)
    elif mutation=='out-of-order': events[0],events[1]=events[1],events[0]
    elif mutation in ('wrong-entity','wrong-actor'):
        event=events[1];args=shlex.split(event['command']);field='entity' if mutation=='wrong-entity' else 'actor';offset=5 if field=='entity' else 4
        args[offset]='other';result=json.loads(event['output']);result[field]='other';event['command']=shlex.join(args);event['output']=json.dumps(result)
    elif mutation=='fabricated': events=[]
    elif mutation=='unproven-branch': events.pop(0)
    elif mutation=='premature-success': events.pop()
    elif mutation=='shortcut':
        event=copy.deepcopy(events[0]);args=shlex.split(event['command']);args[3]='bypass-approval';result=json.loads(event['output']);result['action']='bypass-approval';result['output']={'outcome':'completed','unsafe':'true'};event['command']=shlex.join(args);event['output']=json.dumps(result);events.append(event)
    elif mutation=='bad-input':
        event=events[1];args=shlex.split(event['command']);args[7]='{}';result=json.loads(event['output']);result['input']={};event['command']=shlex.join(args);event['output']=json.dumps(result)
    elif mutation=='altered-result': events[0]['output']=events[0]['output'].replace('1200','1201')
    elif mutation=='backwards-clock': events[-1],events[-2]=events[-2],events[-1]
    _store(row,events)
    passed,reason=check_process_trace(task.process_spec,data)
    assert not passed,(mutation,reason)


def test_legitimate_decline_and_inactive_branch_succeed_but_not_missing_settlement():
    task=_task('investor-outreach');data=_trace(task)
    assert check_process_trace(task.process_spec,data)[0]
    row,events=_events(data)
    events=[e for e in events if json.loads(e['output'])['action']!='verify-settlement']
    _store(row,events)
    assert not check_process_trace(task.process_spec,data)[0]


def test_claude_native_pairs_and_ambiguous_pairing():
    task=_task();data=_trace(task);row,events=_events(data);claude=[]
    for i,event in enumerate(events):
        claude.extend([dict(type='tool_use',tool='Bash',tool_use_id=str(i),input={'command':event['command']}),dict(type='tool_result',tool_use_id=str(i),is_error=False,tool_use_result={'stdout':event['output'],'interrupted':False})])
    _store(row,claude)
    assert check_process_trace(task.process_spec,data)[0]
    claude[1]['tool_use_id']='unrelated-B'
    _store(row,claude)
    assert not check_process_trace(task.process_spec,data)[0]


@pytest.mark.parametrize('mutation',['duplicate','invalid-id','missing-dependency','cycle','impossible-branch','conditional-producer','invalid-day','success-decline','disable','drift'])
def test_process_spec_and_generated_contract_reject_invalidity(mutation):
    task=_task();raw=vars(task);spec=task.process_spec
    if mutation=='duplicate': spec['steps'][1]['id']=spec['steps'][0]['id']
    elif mutation=='invalid-id': spec['steps'][0]['id']='not a step!'
    elif mutation=='missing-dependency': spec['steps'][0]['requires']=['missing']
    elif mutation=='cycle': spec['steps'][0]['requires']=[spec['steps'][-1]['id']]
    elif mutation=='impossible-branch': spec['steps'][2]['when']['equals']='impossible'
    elif mutation=='conditional-producer': spec['steps'][2]['when']['step']=spec['steps'][3]['id']
    elif mutation=='invalid-day': spec['steps'][0]['day']=-1
    elif mutation=='success-decline': spec['steps'][-1]['outputs']['outcome']=['declined']
    elif mutation=='disable': raw['enforce_declared_evaluators']=False
    elif mutation=='drift': raw['evaluators'][1]['criteria']= ['Always pass']
    with pytest.raises(ValueError):
        if mutation in ('disable','drift'): validate_task_process(raw)
        else: validate_process(spec)


def test_canonical_evaluator_generation_and_tree_semantic_boundary():
    from benchmarks import run_benchmark as runner
    task=_task();data=_trace(task)
    calls=[]
    async def judge(**kwargs):
        calls.append(kwargs)
        assert task.process_spec['goal'] in kwargs['verifier_system_prompt']
        assert 'process-semantic' not in kwargs['call_site'] # existing canonical call site
        assert 'fixture-session' in kwargs['context'][1]['text']
        assert 'place-order' in kwargs['context'][1]['text']
        return dict(score=1.0,reasoning='Fixture boundary accepted',verdict_available=True)
    with patch('helpers.llm.check_progress',side_effect=judge),patch.object(runner,'_benchmark_judge_claude_auth_kwargs',AsyncMock(return_value={})),patch.object(runner,'_benchmark_judge_gpt_auth_kwargs',AsyncMock(return_value={})):
        passed,reason,results=asyncio.run(runner._run_declared_evaluators(task,data))
        assert passed,reason
        assert [r['id'] for r in results]==['process-native-trace','process-semantic-adherence']
        assert len(calls)==1
        # Static process enforcement rejects a skip even if the semantic provider would say pass.
        row,events=_events(data);events.pop(0);_store(row,events)
        assert not asyncio.run(runner._run_declared_evaluators(task,data))[0]
        assert len(calls)==1
        task.enforce_declared_evaluators=False
        with pytest.raises(ValueError): asyncio.run(runner._run_declared_evaluators(task,data))


def test_regeneration_drift_cli_and_unchanged_older_catalog_bytes():
    import subprocess
    import sys
    from benchmarks import process_bench
    original=process_bench.CATALOG.read_bytes()
    with tempfile.TemporaryDirectory() as directory:
        catalog=Path(directory)/'tasks.json';catalog.write_bytes(original)
        result=subprocess.run([sys.executable,'-m','benchmarks.process_bench','--catalog',str(catalog),'--write'],capture_output=True,text=True,
                              cwd=Path(__file__).resolve().parents[1])
        assert result.returncode==0,result.stderr
        assert catalog.read_bytes()==original
    assert process_bench.CATALOG.read_bytes()==original



def run_process_controls():
    """Run the same acceptance matrix in the existing deploy-owned blackbox lane."""
    import subprocess
    import sys
    result = subprocess.run([sys.executable, '-m', 'pytest', '-q', str(Path(__file__).resolve())], capture_output=True, text=True,
                            cwd=Path(__file__).resolve().parents[1], timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    print(result.stdout.strip())


@pytest.mark.parametrize('failure',['id-mismatch','nested-id-conflict','nonzero','interrupted','is-error','unknown-status','unrelated-tool-result'])
def test_native_claude_result_identity_and_status_fail_closed(failure):
    from benchmarks.process_bench import _commands
    result={'stdout':'receipt','interrupted':False}
    events=[dict(type='tool_use',tool='Bash',tool_use_id='command-A',input={'command':'python3 fixture.py'}),dict(type='tool_result',tool_use_id='command-A',is_error=False,tool_use_result=result)]
    if failure=='id-mismatch': events[1]['tool_use_id']='unrelated-B'
    elif failure=='nested-id-conflict':result['tool_use_id']='unrelated-B'
    elif failure=='nonzero':result['exitCode']=1
    elif failure=='interrupted':result['interrupted']=True
    elif failure=='is-error':events[1]['is_error']=True
    elif failure=='unknown-status':del events[1]['is_error']
    elif failure=='unrelated-tool-result':
        events.insert(1,dict(type='tool_use',tool='Read',tool_use_id='read-B',input={'file_path':'elsewhere'}))
        events[2]['tool_use_id']='read-B'
    try:
        commands=list(_commands(events))
    except ValueError:
        return
    assert commands==[] or commands[0][4]!=0


def test_supported_older_native_result_with_explicit_id_and_exit_code():
    from benchmarks.process_bench import _commands
    events=[dict(type='tool_use',tool='Bash',tool_use_id='A',input={'command':'real command'}),dict(type='tool_result',tool_use_id='A',tool_use_result={'stdout':'real stdout','exitCode':0})]
    assert list(_commands(events))==[(0,1,'real command','real stdout',0)]


@pytest.mark.parametrize('mutation',['file-change','write-tool','echo-receipt','replacement-script'])
def test_real_looking_forged_fixture_evidence_is_rejected(mutation):
    task=_task();data=_trace(task);row,events=_events(data)
    if mutation=='file-change':events.insert(0,dict(type='file_change',changes=[{'path':FIXTURE_PATH}]))
    elif mutation=='write-tool':events.insert(0,dict(type='tool_use',tool='Write',tool_use_id='tamper',input={'file_path':FIXTURE_PATH,'content':'print(forged_receipt)'}))
    elif mutation=='echo-receipt':events[0]['command']='echo '+shlex.quote(events[0]['output'])+' # process-fixture.py'
    else:events[0]['command']=events[0]['command'].replace(FIXTURE_PATH,'/tmp/process-fixture.py')
    _store(row,events)
    assert not check_process_trace(task.process_spec,data)[0]
    from benchmarks.process_bench import process_evidence
    evidence=json.dumps(process_evidence(data))
    assert ('forged_receipt' if mutation=='write-tool' else 'process-fixture.py') in evidence


def test_missing_process_spec_cannot_disable_runtime_enforcement():
    from benchmarks import run_benchmark as runner
    task=_task();task.process_spec=None;task.enforce_declared_evaluators=False
    with pytest.raises(ValueError):asyncio.run(runner._run_declared_evaluators(task,{}))


async def live_judge_proof():
    """Bounded synthetic evaluator integration, no task/finance/message campaign."""
    from benchmarks import run_benchmark as runner
    task=_task('purchase-approval')
    data=_trace(task)
    results=[]
    for label,trace,expected in [('complete',data,True),('unsubstantive-quote',copy.deepcopy(data),False)]:
        if label=='unsubstantive-quote':
            row,events=_events(trace)
            event=next(e for e in events if json.loads(e['output'])['action']=='compare-quotes')
            args=shlex.split(event['command']);inputs=json.loads(args[7]);inputs['comparison']='I will compare these later.';args[7]=json.dumps(inputs)
            output=json.loads(event['output']);output['input']=inputs;event['command']=shlex.join(args);event['output']=json.dumps(output);_store(row,events)
        passed,reason,evaluations=await runner._run_declared_evaluators(task,trace)
        results.append(dict(case=label,passed=passed,expected=expected,reason=reason,evaluations=evaluations))
        print(json.dumps(results[-1],default=str),flush=True)
        assert passed is expected,(label,reason)
    return results


if __name__=='__main__':
    import sys
    if sys.argv[1:] == ['--live-judge']:
        asyncio.run(live_judge_proof())
    else:
        raise SystemExit('Use pytest, or --live-judge for two bounded synthetic provider evaluations.')


def test_action_started_before_prerequisite_result_fails():
    task=_task();data=_trace(task);row=data['_semantic_evaluator_tree']['child']['messages'][0]
    events=json.loads(row['message'].split('\n\n',1)[1])['code_agent_events']
    # Start quote comparison before request lookup has returned, even though
    # their completions remain in the expected order.
    events[1],events[2]=events[2],events[1]
    row['message']='Code-agent SDK event JSON:\n\n'+json.dumps({'code_agent_events':events})
    assert not check_process_trace(task.process_spec,data)[0]

