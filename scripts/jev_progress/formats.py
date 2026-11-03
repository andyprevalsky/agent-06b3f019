"""Paired input-format ablation; choose only on the development validation set."""
import argparse
import json
from pathlib import Path
from core import FORMATS, SEED, evaluate, load_rows, save, verify_dataset, digest
from optimize import joint_loss


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--dataset', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    cohorts = json.loads((a.output / 'cohorts.json').read_text())
    verify_dataset(a.dataset, cohorts)
    rows = load_rows(a.dataset / 'train.jsonl.gz')
    traces = {t['trace_id']: t for t in load_rows(a.dataset / 'traces.jsonl.gz')}
    dev = [r for r in rows if r['example_id'] in set(cohorts['train_ids'])]
    val = [r for r in rows if r['example_id'] in set(cohorts['validation_ids'])]
    winner = json.loads((a.output / 'winner.json').read_text())
    frozen = a.output / 'text-only-winner.json'
    if not frozen.exists():
        save(frozen, winner)
    winner = json.loads(frozen.read_text())
    baseline = json.loads((a.output / 'validation-baseline.json').read_text())['metrics']
    scores = []
    for parent, prompt in [('seed', SEED), ('optimized', winner['prompt'])]:
        for fmt in FORMATS:
            candidate = {**prompt, 'input_format': fmt} if fmt != 'history' else prompt
            name = f'format-{parent}-{fmt}'
            save(a.output / 'prompts' / (name + '.json'), candidate)
            train = evaluate(dev, traces, candidate, a.output)
            result = evaluate(val, traces, candidate, a.output)
            save(a.output / 'evaluations' / (name + '-train.json'), train)
            save(a.output / 'evaluations' / (name + '-validation.json'), result)
            score = {'name': name, 'prompt': candidate, 'validation_metrics': result['metrics']}
            if not result['metrics']['failed']:
                score['joint_loss'] = joint_loss(result['metrics'], baseline)
                scores.append(score)
            save(a.output / 'format-status.json', {'phase': name, 'candidates': scores})
            print(name, json.dumps(result['metrics']), flush=True)
    best = min(scores, key=lambda c: c['joint_loss'])
    save(a.output / 'winner.json', best)
    save(a.output / 'format-status.json', {'phase': 'complete', 'candidates': scores, 'winner': best['name']})
    save(a.output / 'frozen-test-prompt.json', {'prompt': best['prompt'], 'sha256': digest(best['prompt'])})
    print('FORMAT_WINNER', best['name'], flush=True)


if __name__ == '__main__':
    main()
