"""Re-score frozen per-round selections on success-only cohorts; no test-based selection."""
import argparse,json
from pathlib import Path
from core import load_rows,summarize,evaluate,save,digest,credential,api
from store import Store


def main():
 p=argparse.ArgumentParser(description=__doc__)
 for name in ('dataset','batch','old_test','output'):p.add_argument('--'+name.replace('_','-'),type=Path,required=True)
 a=p.parse_args();s=Store();tr=load_rows(a.dataset/'train.jsonl.gz');te=load_rows(a.dataset/'test.jsonl.gz');trids={r['example_id'] for r in tr};teids={r['example_id'] for r in te};traces={t['trace_id']:t for t in load_rows(a.dataset/'traces.jsonl.gz')};points=[];key=credential('TYPESAFE_API_KEY')
 for folder in sorted(a.batch.glob('round-*')):
  if not (folder/'complete.json').exists():continue
  i=int(folder.name.split('-')[1]);out=a.output/f'round-{i:02d}.json'
  if out.exists():
   points.append(json.loads(out.read_text()));continue
  receipts=[json.loads(f.read_text()) for f in folder.glob('*.receipt.json')];chosen=min(receipts,key=lambda r:r['joint_loss']);candidate=s.get(chosen['artifact'])['candidate'];valrows=[r for r in candidate['validation']['rows'] if r['example_id'] in trids]
  prior=a.old_test/f'round-{i:02d}.json'
  if prior.exists():
   old=json.loads(prior.read_text());assert old['prompt_hash']==digest(candidate['prompt']);testrows=[r for r in s.get(old['artifact'])['test']['rows'] if r['example_id'] in teids]
   assert len(testrows)==len(te);test={'rows':testrows,'metrics':summarize(testrows,len(te))};source=old['artifact']
  else:
   print('CLEAN_TEST_START',i,len(te),flush=True);raw=[]
   def transport(body,_):
    response,latency=api(body,key);raw.append({'request_hash':digest(body),'raw':response});return response,latency
   test=evaluate(te,traces,candidate['prompt'],a.output,workers=12,transport=transport,cache_dir=False);source=s.put({'test':test,'raw':raw,'prompt':candidate['prompt']})
  assert not test['metrics']['failed']
  point={'iteration':i,'candidate':chosen['name'],'prompt_hash':digest(candidate['prompt']),'validation':summarize(valrows,len(valrows)),'test':test['metrics'],'test_source':source,'policy':'Original validation-selected candidate, frozen before cleanup; success-only re-score, no test-based selection'}
  save(out,point);points.append(point);save(a.output/'summary.json',{'points':points,'dataset':str(a.dataset),'policy':point['policy']});print('CLEAN_TEST_COMPLETE',i,json.dumps(point),flush=True)
 save(a.output/'summary.json',{'points':points,'dataset':str(a.dataset),'policy':'Frozen pre-cleanup selections on success-only cohorts'})


if __name__=='__main__':main()
