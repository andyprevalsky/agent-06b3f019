"""Portable continuation state; protocol changes require an explicit migration."""
import copy
from core import BINS, ETA, FORMATS, digest

DEFAULT_CONFIG = {
    'version': 1,
    'filters': {'agent_kinds': ['normal_root', 'normal_child'], 'terminal_status': 'COMPLETED',
                'require_success_evidence': True,
                'require_terminal_tool_receipt': True, 'result_text_chars': 5000,
                'exclude_seen_families': True, 'exclude_seen_normalized_goals': True},
    'protocol': {'model': 'jev-1.13.0', 'progress_anchors': BINS, 'eta_choices': ETA,
                 'input_formats': list(FORMATS), 'goal_normalization': 'casefold-whitespace-v1',
                 'sealed_fraction': '1/5', 'objective': 'equal-normalized-progress-macro-and-eta-log-v1'},
    'search': {'iterations_per_run': 8},
}


def config():
    return copy.deepcopy(DEFAULT_CONFIG)


def validate(state):
    saved = state.get('config')
    if saved is None or 'optimizer' not in state:
        raise ValueError('Checkpoint needs explicit continuation migration; never silently reset it')
    if saved.get('version') != 1 or saved.get('protocol') != DEFAULT_CONFIG['protocol']:
        raise ValueError('Research protocol changed: explicitly migrate the checkpoint before continuing')
    filters = saved['filters']
    if not filters.get('require_success_evidence'):
        raise ValueError('Success-only data cleanup migration required before continuing')
    if any(t.get('success_evidence', {}).get('outcome') != 'SUCCEEDED'
           for t in state.get('train_traces', [])):
        raise ValueError('Training corpus contains unverified task-success outcomes')
    if (filters['terminal_status'] != 'COMPLETED' or not filters['require_terminal_tool_receipt']
            or not filters['exclude_seen_families'] or not filters['exclude_seen_normalized_goals']):
        raise ValueError('Completed-only and sealed evaluation filters cannot be weakened')
    if not set(filters['agent_kinds']) <= {'normal_root', 'normal_child'}:
        raise ValueError('Unsupported persistent-agent kind filter')
    if not 1 <= filters['result_text_chars'] <= 5000 or saved['search']['iterations_per_run'] < 1:
        raise ValueError('Invalid saved research limits')
    if digest(state['champion']) != state['champion_sha256']:
        raise ValueError('Champion checkpoint hash mismatch')
    return saved


def export_optimizer(pool, winner, next_iteration, previous=None):
    from optimize import dominates
    known = {digest(c['prompt']): c for c in (previous or {}).get('candidates', [])}
    for c in pool:
        known[digest(c['prompt'])] = {'name': c['name'], 'prompt': c['prompt'],
                                     'validation_metrics': c['validation']['metrics']}
    frontier = [digest(c['prompt']) for c in pool if not any(
        dominates(d['validation']['metrics'], c['validation']['metrics']) for d in pool if d is not c)]
    return {'schema': 1, 'next_iteration': next_iteration, 'candidates': list(known.values()),
            'frontier': sorted(set(frontier + [digest(winner['prompt'])])),
            'winner_hash': digest(winner['prompt']),
            'policy': 'Rescore incoming champion and retained Pareto prompts on current development data; never reuse stale scores.'}


def warm_candidates(checkpoint, incoming):
    """Only return prompt payloads: historical scores cannot enter selection."""
    return [dict(name=c['name'], prompt=c['prompt']) for c in checkpoint.get('candidates', [])
            if digest(c['prompt']) in checkpoint.get('frontier', []) and digest(c['prompt']) != digest(incoming)]
