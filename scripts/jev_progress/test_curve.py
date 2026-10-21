"""Report-only held-out test curve for completed parallel rounds; never selects prompts."""
import argparse
import json
from pathlib import Path
from core import digest, evaluate, load_rows, save, verify_dataset, api, credential
from store import Store


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch',type=Path,required=True)
    parser.add_argument('--dataset',type=Path,required=True)
    parser.add_argument('--cohorts',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    verify_dataset(args.dataset,json.loads(args.cohorts.read_text()))
    rows=load_rows(args.dataset/'test.jsonl.gz')
    if len(rows)!=2000:raise ValueError('Expected the frozen 2000-case test')
    traces={t['trace_id']:t for t in load_rows(args.dataset/'traces.jsonl.gz')}
    store=Store();points=[]; api_key=credential("TYPESAFE_API_KEY")
    for folder in sorted(args.batch.glob('round-*')):
        if not (folder/'complete.json').exists():continue
        receipts=[json.loads(f.read_text()) for f in folder.glob('*.receipt.json')]
        if len(receipts)!=35:raise ValueError('Only fully completed 35-candidate rounds')
        chosen=min(receipts,key=lambda r:r['joint_loss'])
        candidate=store.get(chosen['artifact'])['candidate']
        iteration=int(folder.name.split('-')[1])
        output=args.output/f'round-{iteration:02d}.json'
        expected={'iteration':iteration,'candidate':chosen['name'],'prompt_hash':digest(candidate['prompt']),
                  'test_cohort_hash':digest(sorted(r['example_id'] for r in rows))}
        if output.exists():
            point=json.loads(output.read_text())
            if any(point.get(k)!=v for k,v in expected.items()):raise ValueError('Frozen report mismatch')
        else:
            print('TEST_START',iteration,chosen['name'],flush=True)
            raw=[]
            def observed(body,key):
                response,latency=api(body,api_key)
                raw.append({'request_hash':digest(body),'raw':response,'latency':latency})
                return response,latency
            result=evaluate(rows,traces,candidate['prompt'],args.output,workers=12,transport=observed,cache_dir=False)
            artifact=store.put({'selection':expected,'validation':chosen['metrics'],'test':result,'raw_responses':raw})
            point={**expected,'validation':chosen['metrics'],'test':result['metrics'],'artifact':artifact}
            save(output,point)
            if result['metrics']['failed']:raise RuntimeError('Test has failed cases; preserved receipt, no selection changes')
        points.append(point)
        save(args.output/'summary.json',{'policy':'Report only. Candidates selected using validation before test. Never used by optimizer.','points':points})
        print('TEST_COMPLETE',json.dumps(point),flush=True)


if __name__=='__main__':main()
