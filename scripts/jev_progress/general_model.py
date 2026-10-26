"""Isolated OpenRouter general-model comparison on the frozen JEV validation set."""
import argparse
import json
from pathlib import Path
import statistics
import time
import urllib.error
import urllib.request
from core import BINS, ETA, credential, decode, digest, evaluate, load_rows, request, save
from optimize import joint_loss


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--experiment',type=Path,required=True)
    p.add_argument('--dataset',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--model',default='deepseek/deepseek-v4.1-flash-1017')
    p.add_argument('--limit',type=int,help='Transport pilot only; do not present as full comparison')
    a=p.parse_args()
    baseline=json.loads((a.experiment/'validation-baseline.json').read_text())
    prompt=json.loads((a.experiment/'prompts/seed.json').read_text())
    wanted={r['example_id'] for r in baseline['rows']}
    rows=[r for r in load_rows(a.dataset/'train.jsonl.gz') if r['example_id'] in wanted]
    if a.limit:rows=rows[:a.limit]
    if baseline['metrics']['failed'] or baseline['prompt_hash']!=digest(prompt):raise ValueError('Baseline mismatch')
    traces={t['trace_id']:t for t in load_rows(a.dataset/'traces.jsonl.gz')}
    api_key=credential('OPENROUTER_API_KEY')
    schema={'type':'object','properties':{
        'remaining_probabilities':{'type':'array','minItems':len(BINS),'maxItems':len(BINS),'items':{'type':'number'}},
        'eta_bucket':{'type':'string','enum':list(ETA)}},
        'required':['remaining_probabilities','eta_bucket'],'additionalProperties':False}
    def body_builder(row,trace,prompt):
        body=request(row,trace,prompt)
        body['model']=a.model
        return body
    def transport(body,_):
        payload={'model':a.model,'reasoning':{'enabled':False},'temperature':0,'max_tokens':384,
          'provider':{'require_parameters':True},
          'messages':[{'role':'system','content':
            'Estimate this agent\'s future tool-batch workload and remaining time using only the observed prefix. '
            'Follow the supplied scope and question instructions. Return JSON only: remaining_probabilities '
            'is a probability distribution over anchors '+str(BINS)+' in that order (last means 55+), '
            'summing to one. eta_bucket must be one exact supplied ETA key. Do not invent future observations.'},
            {'role':'user','content':json.dumps({'state':body['state'],'questions':body['questions']})}],
          'response_format':{'type':'json_schema','json_schema':{'name':'progress_eta','strict':True,'schema':schema}}}
        started=time.monotonic()
        for attempt in range(4):
            try:
                req=urllib.request.Request('https://openrouter.ai/api/v1/chat/completions',data=json.dumps(payload).encode(),
                    headers={'Authorization':'Bearer '+api_key,'Content-Type':'application/json'})
                with urllib.request.urlopen(req,timeout=120) as response:result=json.load(response)
                break
            except urllib.error.HTTPError as exc:
                if exc.code not in (429,500,502,503,504) or attempt==3:
                    detail=exc.read().decode()[:300]
                    raise RuntimeError(f'OpenRouter HTTP {exc.code}: {detail}') from None
                time.sleep(2**attempt)
        actual=result.get('model')
        if actual!=a.model:raise ValueError('Requested/returned model mismatch: '+str(actual))
        answer=json.loads(result['choices'][0]['message']['content'])
        values=answer['remaining_probabilities']
        if len(values)!=len(BINS):raise ValueError('Wrong number of probabilities')
        usage=result.get('usage') or {}
        return {'model':actual,'provider':result.get('provider'),'request_id':result.get('id'),
          'answers':{'remaining_batches':{'probabilities':{str(i):v for i,v in enumerate(values)}},
                     'eta':{'choice':answer['eta_bucket']}},
          'usage':{'input_tokens':usage.get('prompt_tokens',0),'output_tokens':usage.get('completion_tokens',0),
                   'cost':usage.get('cost')},'api_usage':usage},time.monotonic()-started
    result=evaluate(rows,traces,prompt,a.output,workers=16,transport=transport,request_builder=body_builder,
                    decoder=lambda raw,row,trace:decode(raw,row,trace,expected_model=a.model))
    save(a.output/'results.json',result)
    summary={'model':a.model,'thinking':False,'cases':len(rows),'jev':baseline['metrics'],
      'general_model':result['metrics'],'joint_error_ratio':joint_loss(result['metrics'],baseline['metrics']) if not result['metrics']['failed'] and result['metrics'].get('eta_count') else None,
      'new_reported_api_cost_usd':sum((r.get('usage')or{}).get('cost') or 0 for r in result['rows'] if not r.get('cache_hit')),
      'total_reported_case_cost_usd':sum((r.get('usage')or{}).get('cost') or 0 for r in result['rows']),
      'median_latency_seconds':statistics.median(r['latency_seconds'] for r in result['rows'] if r.get('ok')) if result['metrics']['valid'] else None,
      'comparison':'Frozen JEV-optimized instructions; same prefix inputs, bins, decoding, validation IDs. No prompt tuning for this model.'}
    save(a.output/'summary.json',summary)
    print(json.dumps(summary,indent=2),flush=True)


if __name__=='__main__':main()
