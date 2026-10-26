"""Fresh-production prequential audit, then bounded joint prompt/input optimization.

Run bootstrap once, then run weekly. State is encrypted in the research-only
prefix of R2. Nothing here changes production prompts or writes the database.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys

from core import balanced, digest, evaluate, load_rows, prepare, save
from production import examples, pull
from store import Store
from checkpoint import config, validate, export_optimizer


def now():
    return datetime.now(timezone.utc).isoformat()


def goal_key(trace):
    return digest(' '.join(trace['goal'].casefold().split()))


def partition(traces, state):
    """Keep root families AND identical normalized goals together, permanently."""
    parent = {t['family_id']: t['family_id'] for t in traces}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    owners = {}
    for t in traces:
        goal = goal_key(t)
        if goal in owners:
            parent[find(t['family_id'])] = find(owners[goal])
        owners[goal] = t['family_id']
    groups = defaultdict(list)
    for t in traces:
        groups[find(t['family_id'])].append(t)
    fresh_test, new_train = [], []
    for group, items in groups.items():
        known = {state['goals'][goal_key(t)] for t in items if goal_key(t) in state['goals']}
        if 'sealed' in known:
            role = 'sealed'
        elif known:
            role = 'train'
        else:
            assignment = hmac.new(bytes.fromhex(state['split_salt']), group.encode(), hashlib.sha256).digest()
            role = 'sealed' if int.from_bytes(assignment[:4], 'big') % 5 == 0 else 'train'
        for t in items:
            t['split_group'] = group
            state['goals'][goal_key(t)] = role
            state['seen_families'].append(t['family_id'])
        if role == 'train' and not known:
            new_train.extend(items)
        elif not known:
            fresh_test.extend(items)
    state['seen_families'] = sorted(set(state['seen_families']))
    return fresh_test, new_train


def write_rows(path, rows):
    with gzip.open(path, 'wt') as f:
        for row in rows:
            f.write(json.dumps(row) + '\n')


def bootstrap(args, store):
    traces = load_rows(args.dataset / 'traces.jsonl.gz')
    if any(t.get('success_evidence', {}).get('outcome') != 'SUCCEEDED' for t in traces):
        raise ValueError('Bootstrap requires positive success evidence on every trace')
    train = load_rows(args.dataset / 'train.jsonl.gz')
    test = load_rows(args.dataset / 'test.jsonl.gz')
    training_ids = {r['trace_id'] for r in train}
    sealed_ids = {r['trace_id'] for r in test}
    prompt_document = json.loads(args.prompt.read_text())
    prompt = prompt_document.get('prompt', prompt_document)
    goals = {}
    for t in traces:
        if t['trace_id'] in training_ids | sealed_ids:
            key = goal_key(t)
            role = 'sealed' if t['trace_id'] in sealed_ids else 'train'
            if key in goals and goals[key] != role:
                raise ValueError('Initial train/test goal overlap')
            goals[key] = role
    state = {'schema': 1, 'watermark': now(), 'champion': prompt, 'champion_sha256': digest(prompt),
             'split_salt': os.urandom(32).hex(), 'seen_families': sorted({t['family_id'] for t in traces}),
             'goals': goals, 'train_rows': train, 'train_traces': [t for t in traces if t['trace_id'] in training_ids],
             'history': [], 'policy': 'Frozen incoming champion; fresh unseen sealed families; no sealed labels in optimization.'}
    state['config'] = config()
    state['optimizer'] = {'schema': 1, 'next_iteration': 1, 'candidates': [], 'frontier': []}
    state['development_split'] = None
    key = store.advance(state)
    save(args.output / 'bootstrap.json', {'state': key, 'watermark': state['watermark'], 'champion_sha256': digest(prompt)})
    print('BOOTSTRAPPED', key, state['watermark'], flush=True)


def migrate(args, store):
    """One-time adoption of an existing checkpoint, preserving its history."""
    head, etag = store.head()
    state = store.get(head['state'])
    if 'config' in state:
        raise ValueError('Already migrated; refusing to reset continuation state')
    archive = store.get(args.experiment_key)['artifacts']
    pool = []
    for path, value in archive.items():
        if not path.startswith('evaluations/') or not path.endswith('-validation.json'):
            continue
        name = path.removeprefix('evaluations/').removesuffix('-validation.json')
        prompt = archive.get('prompts/' + name + '.json')
        if prompt and not value['metrics']['failed']:
            pool.append({'name': name, 'prompt': prompt, 'validation': value})
    pool.append({'name': 'seed', 'prompt': archive['prompts/seed.json'],
                 'validation': archive['validation-baseline.json']})
    winner = next(c for c in pool if digest(c['prompt']) == state['champion_sha256'])
    next_iteration = 1 + max([int(c['name'].split('-')[1]) for c in pool
                              if c['name'].startswith('candidate-')] or [0])
    state['optimizer'] = export_optimizer(pool, winner, next_iteration)
    state['config'] = config()
    state['development_split'] = {k: archive['cohorts.json'][k] for k in ('validation_groups', 'validation_ids')}
    state['continuation_migration'] = {'previous_state': head['state'], 'experiment': args.experiment_key,
                                       'timestamp': now(), 'watermark_unchanged': state['watermark']}
    validate(state)
    key = store.advance(state, etag)
    save(args.output / 'continuation-migration.json', {'state': key, 'watermark': state['watermark'],
                                                     'next_iteration': next_iteration})
    print('CONTINUATION_MIGRATED', key, 'next_iteration', next_iteration, flush=True)


def run(args, store):
    head, etag = store.head()
    state = store.get(head['state'])
    saved_config = validate(state)
    if args.iterations is not None:
        if args.iterations < 1:
            raise ValueError('Iterations must be positive')
        saved_config['search']['iterations_per_run'] = args.iterations
    if args.patience is not None:
        if args.patience < 1:
            raise ValueError('Patience must be positive')
        saved_config['search']['patience'] = args.patience
    until = now()
    run_id = until.replace(':', '').replace('+', '_')
    output = args.output / run_id
    output.mkdir(parents=True, exist_ok=True)
    incoming = state['champion']
    # Durable freeze exists before any production query. A fresh run must not
    # change this prompt after looking at its sealed labels or scores.
    freeze = {'run_id': run_id, 'from': state['watermark'], 'until': until,
              'incoming_prompt': incoming, 'prompt_sha256': digest(incoming), 'previous_state': head['state'],
              'config': saved_config, 'config_sha256': digest(saved_config),
              'next_iteration': state['optimizer']['next_iteration']}
    store.receipt(run_id + '-freeze', freeze)
    fresh, acquisition = pull(state['watermark'], until, set(state['seen_families']), saved_config['filters'])
    sealed, new_train = partition(fresh, state)
    # Complete every prefix; report this event-weighted distribution explicitly.
    # Never choose test examples based on labels or the current model's errors.
    test_rows = examples(sealed)
    test = evaluate(test_rows, {t['trace_id']: t for t in sealed}, incoming, output)
    if test['metrics']['failed']:
        raise RuntimeError('Prospective evaluation has failed cases; do not advance or train')
    receipt = {'freeze': freeze, 'acquisition': acquisition, 'metrics': test['metrics'],
               'sealed_families': len({t['family_id'] for t in sealed}),
               'sealed_examples': len(test_rows), 'distribution': 'All prefix events in unseen completed persistent agent families; random 20% of novel goal components.',
               'sealed_data': store.put({'traces': sealed, 'rows': test_rows, 'results': test}),
               'no_test_selection': True}
    receipt_key = store.receipt(run_id + '-prospective', receipt)
    # Only this aggregate is visible in normal output. Reflectors see training
    # failures, never sealed rows, traces, results, or this receipt.
    save(output / 'prospective-summary.json', {k: v for k, v in receipt.items() if k != 'sealed_data'})
    print('PROSPECTIVE', json.dumps(receipt['metrics']), flush=True)
    if new_train or args.train_existing:
        state['train_rows'].extend(examples(new_train))
        state['train_traces'].extend(new_train)
        dataset = output / 'dataset'
        dataset.mkdir()
        write_rows(dataset / 'train.jsonl.gz', state['train_rows'])
        # Historical and prospective test rows NEVER enter the optimizer's dataset.
        write_rows(dataset / 'test.jsonl.gz', [])
        write_rows(dataset / 'traces.jsonl.gz', state['train_traces'])
        experiment = output / 'optimization'
        cohorts = prepare(dataset, experiment, frozen_split=state['development_split'])
        state['development_split'] = {k: cohorts[k] for k in ('validation_groups', 'validation_ids')}
        save(experiment / 'prompts/seed.json', incoming)
        by_id = {t['trace_id']: t for t in state['train_traces']}
        for split in ('train', 'validation'):
            wanted = set(cohorts[split + '_ids'])
            result = evaluate([r for r in state['train_rows'] if r['example_id'] in wanted], by_id, incoming, experiment)
            if result['metrics']['failed']:
                raise RuntimeError('Development baseline failed; do not advance')
            save(experiment / (split + '-baseline.json'), result)
        start = state['optimizer']['next_iteration']
        save(experiment / 'warm-start.json', state['optimizer'])
        subprocess.run([sys.executable, str(Path(__file__).with_name('optimize.py')),
                        '--dataset', str(dataset), '--output', str(experiment), '--start-at', str(start),
                        '--iterations', str(start + saved_config['search']['iterations_per_run'] - 1),
                        '--patience', str(saved_config['search'].get('patience', 4)),
                        '--warm-start', str(experiment / 'warm-start.json')], check=True)
        winner = json.loads((experiment / 'winner.json').read_text())
        state['champion'] = winner['prompt']
        state['champion_sha256'] = digest(winner['prompt'])
        state['last_validation'] = winner['validation_metrics']
        state['optimizer'] = json.loads((experiment / 'optimizer-state.json').read_text())
        # Retain all measured proposals and reflection receipts durably.
        state['last_experiment'] = store.put({str(p.relative_to(experiment)): json.loads(p.read_text())
                                             for p in experiment.rglob('*.json')})
    state['watermark'] = until
    state['history'].append({'run_id': run_id, 'receipt': receipt_key, 'metrics': test['metrics'],
                             'incoming_sha256': digest(incoming), 'next_sha256': state['champion_sha256']})
    store.advance(state, etag)
    save(output / 'complete.json', {'run_id': run_id, 'receipt': receipt_key, 'next_prompt_sha256': state['champion_sha256']})
    print('WEEKLY_COMPLETE', run_id, flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['bootstrap', 'run', 'migrate'])
    p.add_argument('--output', type=Path, default=Path('.context/jev-weekly'))
    p.add_argument('--dataset', type=Path)
    p.add_argument('--prompt', type=Path)
    p.add_argument('--iterations', type=int, help='Explicitly override and persist the per-run budget')
    p.add_argument('--train-existing', action='store_true', help='Continue optimization even if no new training families arrive')
    p.add_argument('--patience', type=int, help='Persist consecutive non-improvement allowance; permits plateau probes')
    p.add_argument('--experiment-key', help='Encrypted initial experiment object for one-time adoption')
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.command == 'bootstrap' and (args.dataset is None or args.prompt is None):
        p.error('bootstrap needs --dataset and --prompt')
    if args.command == 'migrate' and not args.experiment_key:
        p.error('migrate needs --experiment-key')
    store = Store()
    {'bootstrap': bootstrap, 'run': run, 'migrate': migrate}[args.command](args, store)


if __name__ == '__main__':
    main()
