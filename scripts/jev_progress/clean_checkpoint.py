"""Explicit success-only checkpoint migration; preserve prompts, history and split ownership."""
import argparse,json
from pathlib import Path
from core import load_rows,save,summarize,digest
from checkpoint import validate
from store import Store


def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--dataset',type=Path,required=True);p.add_argument('--batch',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 s=Store();head,etag=s.head();state=s.get(head['state'])
 if state.get('data_quality',{}).get('version')=='success-only-v2':raise ValueError('Already migrated')
 manifest=json.loads((a.dataset/'manifest.json').read_text());traces=load_rows(a.dataset/'traces.jsonl.gz');rows=load_rows(a.dataset/'train.jsonl.gz');tests=load_rows(a.dataset/'test.jsonl.gz');ids={r['example_id'] for r in rows};tids={t['trace_id'] for t in traces}
 original={k:len(state[k]) for k in ('train_rows','train_traces')}
 state['train_rows']=[r for r in state['train_rows'] if r['example_id'] in ids]
 state['train_traces']=[t for t in traces if t['trace_id'] in {r['trace_id'] for r in state['train_rows']}]
 state['development_split']['validation_ids']=[i for i in state['development_split']['validation_ids'] if i in ids]
 # Retain every proposed prompt and prior score as historical evidence only.
 for c in state['optimizer']['candidates']:
  if 'validation_metrics' in c:c['pre_cleanup_validation_metrics']=c.pop('validation_metrics')
 # Recompute carried champion metrics from exactly the same saved predictions.
 receipt=next(json.loads(f.read_text()) for f in a.batch.glob('round-*/*.receipt.json') if digest(json.loads((f.parent/(f.name.replace('.receipt.json','.prompt.json'))).read_text()))==state['champion_sha256'])
 candidate=s.get(receipt['artifact'])['candidate'];keep=[r for r in candidate['validation']['rows'] if r['example_id'] in ids]
 state['last_validation']=summarize(keep,len(keep))
 dataset_key=s.put({'manifest':manifest,'traces':traces,'train_rows':rows,'test_rows':tests,'audit':json.loads((a.dataset/'audit.json').read_text())})
 state['config']['filters']['require_success_evidence']=True
 state['data_quality']={'version':'success-only-v2','dataset':dataset_key,'previous_state':head['state'],'original_counts':original,'clean_validation_count':len(keep),'selection_note':'Existing champion carried forward; old selection metrics invalidated. All warm candidates must be rescored on clean data before selection.'}
 validate(state);key=s.advance(state,etag)
 save(a.output,{'state':key,'dataset':dataset_key,'counts':{'train':len(state['train_rows']),'test':len(tests),'validation':len(keep)},'previous_state':head['state']})
 print(json.dumps({'state':key,'train':len(state['train_rows']),'test':len(tests),'validation':len(keep)},indent=2))


if __name__=='__main__':main()
