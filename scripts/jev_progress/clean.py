"""Create an immutable success-only dataset version, retaining original split assignments."""
import argparse
from collections import Counter
import hashlib,json
from pathlib import Path
from core import load_rows,save
from weekly import write_rows
from success import success_verdict


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True);p.add_argument('--evidence',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    if a.output.exists():raise ValueError('Never overwrite a dataset version')
    traces=load_rows(a.source/'traces.jsonl.gz');evidence={e['id']:e for e in load_rows(a.evidence)}
    audit=[];kept=[]
    for t in traces:
        ok,reason=success_verdict(t,evidence.get(t['trace_id']))
        audit.append({'trace_id':t['trace_id'],'kind':t['kind'],'eligible':ok,'reason':reason})
        if ok:
            t['success_evidence']={'outcome':'SUCCEEDED','basis':reason,'message_id':evidence[t['trace_id']].get('message_id') if t['trace_id'] in evidence else None}
            kept.append(t)
    ids={t['trace_id'] for t in kept};a.output.mkdir(parents=True)
    report={'policy':'success-only-v2; positive final task-success evidence required; no duration cutoff; original splits retained; no replacement rows',
            'source':str(a.source),'trace_counts':{'original':len(traces),'retained':len(kept),'quarantined':len(traces)-len(kept)},
            'reasons':dict(Counter(r['reason'] for r in audit if not r['eligible'])),
            'retained_kinds':dict(Counter(t['kind'] for t in kept)),'splits':{}}
    for split in ('train','test'):
        rows=load_rows(a.source/(split+'.jsonl.gz'));good=[r for r in rows if r['trace_id'] in ids]
        report['splits'][split]={'original':len(rows),'retained':len(good),'removed':len(rows)-len(good)}
        write_rows(a.output/(split+'.jsonl.gz'),good)
    write_rows(a.output/'traces.jsonl.gz',kept)
    report['sha256']={n:hashlib.sha256((a.output/n).read_bytes()).hexdigest() for n in ('train.jsonl.gz','test.jsonl.gz','traces.jsonl.gz')}
    save(a.output/'audit.json',audit);save(a.output/'manifest.json',report)
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
