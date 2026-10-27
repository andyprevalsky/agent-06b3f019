"""Isolated paired ablation: add one strictly earlier, frozen JEV prediction."""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
from core import digest, evaluate, load_rows, request, save, summarize
from optimize import joint_loss


def build_priors(rows, traces, results):
    predictions = {r['example_id']: r for r in results['rows'] if r.get('ok')}
    by_trace = defaultdict(list)
    for row in rows:
        by_trace[row['trace_id']].append(row)
    priors = {}
    def time_at(events, cutoff):
        visible = events[:cutoff+1]
        stamp = next((e.get('timestamp') for e in reversed(visible) if e.get('timestamp')), None)
        if stamp is None:
            return None
        value = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
    for trace_id, group in by_trace.items():
        group.sort(key=lambda r: r['cutoff_event_index'])
        for previous, current in zip(group, group[1:]):
            assert previous['cutoff_event_index'] < current['cutoff_event_index']
            prediction = predictions[previous['example_id']]
            events = traces[trace_id]['events']
            previous_events = events[:previous['cutoff_event_index']+1]
            current_events = events[:current['cutoff_event_index']+1]
            prior_time = time_at(events, previous['cutoff_event_index'])
            current_time = time_at(events, current['cutoff_event_index'])
            priors[current['example_id']] = {
                'predicted_progress_fraction': prediction['predicted_progress'],
                'predicted_remaining_tool_batches': prediction['remaining_predicted'],
                'predicted_eta_seconds': prediction['eta_predicted'],
                'additional_observed_batches': sum(e['role']=='assistant' for e in current_events)-sum(e['role']=='assistant' for e in previous_events),
                'seconds_since_prediction': max(0,(current_time-prior_time).total_seconds()) if prior_time and current_time else None,
                'interpretation': 'Earlier model estimate, not ground truth. Revise it if current evidence disagrees.'}
    return priors


def builder(priors):
    def construct(row, trace, prompt):
        body = request(row, trace, prompt)
        if row['example_id'] in priors:
            body['state']['previous_jev_prediction'] = priors[row['example_id']]
        return body
    return construct


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--experiment', type=Path, required=True)
    p.add_argument('--dataset', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--recursive', action='store_true', help='Feed each new prediction into the next sampled prefix')
    a = p.parse_args()
    baseline = json.loads((a.experiment/'validation-baseline.json').read_text())
    prompt = json.loads((a.experiment/'prompts/seed.json').read_text())
    wanted = {r['example_id'] for r in baseline['rows']}
    rows = [r for r in load_rows(a.dataset/'train.jsonl.gz') if r['example_id'] in wanted]
    if baseline['metrics']['failed'] or len(rows)!=500 or baseline['prompt_hash']!=digest(prompt):
        raise ValueError('Expected a complete frozen 500-case baseline and matching prompt')
    traces = {t['trace_id']:t for t in load_rows(a.dataset/'traces.jsonl.gz')}
    priors = build_priors(rows, traces, baseline)
    save(a.output/'protocol.json',{'condition':'Only add one prior JEV prediction to state; prompt, examples and decoding fixed.',
        'prior_source':('Previous prediction from this rollout at a strictly earlier sampled prefix.' if a.recursive
                        else 'Frozen baseline predictions at strictly earlier sampled prefixes of the same trace.'),
        'cohort_hash':baseline['cohort_hash'],'prompt_hash':digest(prompt),
        'with_prior':len(priors),'without_prior':len(rows)-len(priors),
        'limitation':('Recursive across sampled prefixes, not every production update; not a fresh-data test.' if a.recursive
                      else 'One-step offline ablation; not recursive rollouts or an independent future-data test.')})
    if a.recursive:
        grouped=defaultdict(list)
        for row in rows:grouped[row['trace_id']].append(row)
        def chain(group):
            outputs=[];previous=None
            for row in sorted(group,key=lambda r:r['cutoff_event_index']):
                local_priors={} if previous is None else build_priors([previous,row],traces,{'rows':[outputs[-1]]})
                evaluated=evaluate([row],traces,prompt,a.output,workers=1,request_builder=builder(local_priors))
                outputs.extend(evaluated['rows'])
                if evaluated['metrics']['failed']:break
                previous=row
            return outputs
        with ThreadPoolExecutor(max_workers=4) as executor:
            outputs=[r for group in executor.map(chain,grouped.values()) for r in group]
        result={'prompt_hash':digest(prompt),'cohort_hash':baseline['cohort_hash'],
                'rows':outputs,'metrics':summarize(outputs,len(rows))}
    else:
        result = evaluate(rows,traces,prompt,a.output,request_builder=builder(priors))
    save(a.output/'with-previous.json',result)
    if result['metrics']['failed']:
        raise RuntimeError('Ablation has failed cases; no success claim')
    summary={'baseline':baseline['metrics'],'with_previous':result['metrics'],
             'joint_error_ratio':joint_loss(result['metrics'],baseline['metrics']),
             'with_prior':len(priors),'without_prior':len(rows)-len(priors)}
    summary['mode']='recursive sampled-prefix rollout' if a.recursive else 'one-step frozen-prior ablation'
    save(a.output/'summary.json',summary)
    print(json.dumps(summary,indent=2),flush=True)


if __name__=='__main__':main()
