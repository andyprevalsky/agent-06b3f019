"""Parallel candidate rounds; adapt only after a complete round is scored.

Every candidate receives the identical development cohort and scoring rule.
Raw API receipts and scored results are encrypted in R2 before selection.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
import multiprocessing
import json
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

from checkpoint import export_optimizer, validate, warm_candidates
from core import credential, digest, evaluate, load_rows, request, save, verify_dataset, FORMATS
from optimize import dominates, feedback, joint_loss, reflect
from store import Store

_BUILD_TRACES = None


def initialize_builder(traces):
    global _BUILD_TRACES
    _BUILD_TRACES=traces


def build_request(row,prompt):
    return request(row,_BUILD_TRACES[row['trace_id']],prompt)


class Transport:
    def __init__(self, limit=48):
        self.key=credential('TYPESAFE_API_KEY')
        self.condition=threading.Condition()
        self.limit=limit
        self.active=0
        self.pause_until=0
        self.successes=0
        self.rate_limits=0
        self.last_limit=0

    def __call__(self, body, ignored):
        started=time.monotonic()
        for attempt in range(8):
            with self.condition:
                while self.active>=self.limit or time.monotonic()<self.pause_until:
                    self.condition.wait(timeout=.25)
                self.active+=1
            retry=None
            try:
                req=urllib.request.Request('https://api.typesafe.ai/v1/systemone',data=json.dumps(body).encode(),
                    headers={'Authorization':'Bearer '+self.key,'Content-Type':'application/json'})
                with urllib.request.urlopen(req,timeout=60) as response:
                    raw=json.load(response)
                with self.condition:
                    self.successes+=1
                    if self.successes%250==0 and time.monotonic()-self.last_limit>60:
                        self.limit=min(128,self.limit+2)
                return raw,time.monotonic()-started
            except urllib.error.HTTPError as exc:
                if exc.code not in (429,500,502,503,504) or attempt==7:
                    raise RuntimeError(f'TypeSafe HTTP {exc.code}') from None
                try: retry=float(exc.headers.get('retry-after','2'))
                except ValueError: retry=2
                if exc.code==429:
                    with self.condition:
                        self.rate_limits+=1
                        self.last_limit=time.monotonic()
                        self.limit=max(4,self.limit//2)
                        self.pause_until=max(self.pause_until,time.monotonic()+retry)
            except (TimeoutError,urllib.error.URLError):
                if attempt==7:raise RuntimeError('TypeSafe transport retries exhausted') from None
                retry=2+attempt
            finally:
                with self.condition:
                    self.active-=1
                    self.condition.notify_all()
            time.sleep(min(30,retry or 1))

    def stats(self):
        with self.condition:
            return {'successful_requests':self.successes,'rate_limit_responses':self.rate_limits,
                    'concurrency_limit':self.limit,'inflight':self.active}


def frontier(pool):
    return [c for c in pool if not any(dominates(d['validation']['metrics'],c['validation']['metrics'])
                                     for d in pool if d is not c)]


def select_completed_round(pool, completed, width, baseline):
    if len(completed)!=width or any(c[s]['metrics']['failed'] for c in completed for s in ('train','validation')):
        raise ValueError('Only a full, successful paired round can be selected')
    combined=pool+completed
    return combined,min(combined,key=lambda c:joint_loss(c['validation']['metrics'],baseline))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--dataset',type=Path,required=True)
    p.add_argument('--cohorts',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--width',type=int,default=35)
    p.add_argument('--rounds',type=int,default=5)
    p.add_argument('--builder-processes',type=int,default=6,help='CPU workers for prefix formatting; HTTP concurrency stays bounded')
    a=p.parse_args()
    if a.width<1 or a.rounds<1: p.error('width and rounds must be positive')
    a.output.mkdir(parents=True,exist_ok=True)
    store=Store()
    initial_path=a.output/'initial.json'
    if initial_path.exists():
        initial=json.loads(initial_path.read_text())
        head,etag=store.head()
        if head['state']!=initial['head_state']:
            raise RuntimeError('Durable state changed; use a new batch output or inspect its completed rounds')
        state=store.get(head['state'])
    else:
        head,etag=store.head(); state=store.get(head['state'])
        initial={'source_state':head['state'],'head_state':head['state'],'completed_rounds':0,
                 'width':a.width,'rounds':a.rounds,'start':state['optimizer']['next_iteration'],
                 'prompt_hash':state['champion_sha256'],'started':time.time()}
        save(initial_path,initial)
    source_state=store.get(initial['source_state'])
    validate(state)
    if (initial['width'],initial['rounds'])!=(a.width,a.rounds):raise ValueError('Frozen batch plan differs')
    cohorts=json.loads(a.cohorts.read_text());verify_dataset(a.dataset,cohorts)
    train_all=load_rows(a.dataset/'train.jsonl.gz')
    train=[r for r in train_all if r['example_id'] in set(cohorts['train_ids'])]
    val=[r for r in train_all if r['example_id'] in set(cohorts['validation_ids'])]
    traces={t['trace_id']:t for t in load_rows(a.dataset/'traces.jsonl.gz')}
    builders=ProcessPoolExecutor(max_workers=a.builder_processes,mp_context=multiprocessing.get_context('spawn'),
                                initializer=initialize_builder,initargs=(traces,))
    def parallel_builder(row,trace,prompt):
        return builders.submit(build_request,row,prompt).result()
    if set(cohorts['validation_ids'])!=set(state['development_split']['validation_ids']):
        raise ValueError('Validation cohort changed')
    transport=Transport()
    pool=[]
    # Reuse exact request caches for incumbent rescoring, never old scores.
    for c in [{'name':'incoming','prompt':source_state['champion']}]+warm_candidates(state['optimizer'],source_state['champion']):
        tr=evaluate(train,traces,c['prompt'],a.output,request_builder=parallel_builder)
        vr=evaluate(val,traces,c['prompt'],a.output,request_builder=parallel_builder)
        if tr['metrics']['failed'] or vr['metrics']['failed']:raise RuntimeError('Incumbent rescore failed')
        pool.append({**c,'train':tr,'validation':vr})
    baseline=pool[0]['validation']['metrics']
    save(a.output/'baseline.json',baseline)
    next_id=initial['start']+initial['completed_rounds']*a.width
    previous=state['optimizer']
    winner=min(pool,key=lambda c:joint_loss(c['validation']['metrics'],baseline))
    themes=['Keep compact, explicit rules and remove redundant qualifications.',
            'Use elapsed time and observed tool timing carefully; distinguish active work from waits.',
            'Interpret completion receipts and repeated tool results without premature completion.',
            'Infer remaining work from the goal and output schema, including required verification.',
            'Reduce both overly optimistic progress and catastrophic long ETA estimates.',
            'Handle delegated parent work and the agent-local batch definition precisely.',
            'Use concrete evidence-driven phase estimates and avoid guessing from elapsed time alone.']
    for round_index in range(initial['completed_rounds'],a.rounds):
        frozen=list(frontier(pool))
        selections=[]
        for slot in range(a.width):
            parent=winner if slot%3 else frozen[(slot//3)%len(frozen)]
            selections.append((next_id+slot,parent,FORMATS[slot%len(FORMATS)],themes[slot%len(themes)]))
        # Parent identities and the cohort freeze before any candidate in this
        # round is evaluated. No intra-round adaptive selection.
        round_dir=a.output/f'round-{round_index+1:02d}'
        save(round_dir/'plan.json',{'round':round_index+1,'parents':[{'candidate':i,'parent':digest(c['prompt']),
             'format':fmt} for i,c,fmt,_ in selections],'baseline':baseline,'cohort_hash':digest(cohorts)})
        completed=[]
        def candidate(job):
            number,parent,fmt,theme=job
            name=f'candidate-{number:03d}'
            receipt_file=round_dir/(name+'.receipt.json')
            if receipt_file.exists():return store.get(json.loads(receipt_file.read_text())['artifact'])['candidate']
            prompt_file=round_dir/(name+'.prompt.json')
            if prompt_file.exists():prompt=json.loads(prompt_file.read_text())
            else:
                focus=f'Round {round_index+1}, independent proposal {number}. Jointly improve progress AND ETA. '+theme+f' Use input_format={fmt}.'
                for attempt in range(4):
                    try:
                        prompt=reflect(parent['prompt'],feedback(train,traces,parent['train'],parent['prompt']),focus,
                                       round_dir/(name+'.reflection.json'))
                        break
                    except urllib.error.HTTPError as exc:
                        if exc.code not in (429,500,502,503,504) or attempt==3:raise
                        time.sleep(2**attempt)
                prompt['input_format']=fmt
                save(prompt_file,prompt)
            raw=[]
            def observed(body,key):
                value,latency=transport(body,key)
                raw.append({'request_hash':digest(body),'raw':value,'latency':latency})
                return value,latency
            tr=evaluate(train,traces,prompt,round_dir,workers=4,transport=observed,cache_dir=False,request_builder=parallel_builder)
            vr=evaluate(val,traces,prompt,round_dir,workers=4,transport=observed,cache_dir=False,request_builder=parallel_builder)
            if tr['metrics']['failed'] or vr['metrics']['failed']:
                save(round_dir/(name+'.failed.json'),{'train':tr,'validation':vr})
                raise RuntimeError(name+' has failed cases; no round promotion')
            c={'name':name,'prompt':prompt,'train':tr,'validation':vr}
            artifact=store.put({'candidate':c,'raw_responses':raw,'round':round_index+1})
            save(receipt_file,{'artifact':artifact,'name':name,'metrics':vr['metrics'],
                               'joint_loss':joint_loss(vr['metrics'],baseline)})
            return c
        with ThreadPoolExecutor(max_workers=a.width) as executor:
            futures=[executor.submit(candidate,job) for job in selections]
            for future in as_completed(futures):
                c=future.result();completed.append(c)
                status={'round':round_index+1,'round_done':len(completed),'round_total':a.width,
                        'completed_total':round_index*a.width+len(completed),'planned_total':a.width*a.rounds,
                        'latest_candidate':c['name'],'latest_joint_loss':joint_loss(c['validation']['metrics'],baseline),
                        'transport':transport.stats(),'elapsed_seconds':time.time()-initial['started']}
                save(a.output/'status.json',status)
                print(json.dumps(status),flush=True)
        pool,winner=select_completed_round(pool,completed,a.width,baseline)
        next_id+=a.width
        state['optimizer']=export_optimizer(pool,winner,next_id,previous)
        previous=state['optimizer']
        state['champion']=winner['prompt'];state['champion_sha256']=digest(winner['prompt'])
        state['last_validation']=winner['validation']['metrics']
        state['last_batch_plan']={'width':a.width,'rounds':a.rounds,'completed_rounds':round_index+1,
                                  'baseline':baseline,'initial_state':initial['source_state']}
        receipt_keys=[json.loads(f.read_text())['artifact'] for f in sorted(round_dir.glob('*.receipt.json'))]
        manifest_key=store.put({'round':round_index+1,'plan':json.loads((round_dir/'plan.json').read_text()),
                               'candidates':receipt_keys,'winner':winner['name'],
                               'winner_metrics':winner['validation']['metrics']})
        state.setdefault('batch_rounds',[]).append(manifest_key)
        state_key=store.advance(state,etag)
        head,etag=store.head()
        if head['state']!=state_key:raise RuntimeError('Concurrent state advance detected')
        # The next round resumes from this saved state if this process stops.
        initial['head_state']=state_key
        initial['completed_rounds']=round_index+1
        save(initial_path,initial)
        save(round_dir/'complete.json',{'winner':winner['name'],'metrics':winner['validation']['metrics'],
            'joint_loss':joint_loss(winner['validation']['metrics'],baseline),'state':state_key})
        # Retain only current Pareto parents and the champion in memory. Full
        # scored candidates and raw probabilities already live in encrypted R2.
        pool=frontier(pool)
        if all(digest(c['prompt'])!=digest(winner['prompt']) for c in pool):pool.append(winner)
    save(a.output/'complete.json',{'winner':winner['name'],'metrics':winner['validation']['metrics'],
        'joint_loss':joint_loss(winner['validation']['metrics'],baseline),'candidates':a.width*a.rounds,
        'elapsed_seconds':time.time()-initial['started'],'transport':transport.stats()})
    print('BATCH_COMPLETE',flush=True)
    builders.shutdown()


if __name__=='__main__':main()
