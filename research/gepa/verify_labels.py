"""Verify preference labels: detect malformed data, duplicates, missing pairs, and preference cycles.

Cycle detection covers:
  - Hard cycles: A > B, B > C, C > A  (all strict)
  - Soft cycles: A > B, B == C, C > A  (mix of strict + tie, at least one strict)

Run: python research/gepa/verify_labels.py
"""

import json
import sys
from collections import defaultdict
from itertools import combinations
from pathlib import Path

LABELS_PATH = Path(__file__).parent / 'data' / 'preference_labels.json'

REQUIRED_FIELDS = {'pair_id', 'task_id', 'task_seed', 'candidate_a_idx', 'candidate_b_idx', 'preference', 'label_time_s', 'timestamp'}
VALID_PREFERENCES = {'A', 'B', 'TIE', 'SKIP', 'SKIP_TASK'}
K_CANDIDATES = 4
EXPECTED_PAIRS = set(combinations(range(K_CANDIDATES), 2))  # {(0,1),(0,2),(0,3),(1,2),(1,3),(2,3)}


def verify(labels: list[dict]) -> dict:
    issues = {
        'malformed': [],       # structural / field issues
        'duplicates': [],      # same (task_id, a_idx, b_idx) appears >1 time
        'missing_pairs': [],   # task has <6 non-SKIP_TASK labels
        'hard_cycles': [],     # A>B, B>C, C>A (all strict)
        'soft_cycles': [],     # A>B, B==C, C>A (tie in chain, at least one strict)
    }

    # --- 1. Field-level validation ---
    for i, label in enumerate(labels):
        missing = REQUIRED_FIELDS - set(label.keys())
        if missing:
            issues['malformed'].append(f'Label {i}: missing fields {missing}')

        pref = label.get('preference')
        if pref not in VALID_PREFERENCES:
            issues['malformed'].append(f'Label {i}: invalid preference "{pref}"')

        a, b = label.get('candidate_a_idx'), label.get('candidate_b_idx')
        if not isinstance(a, int) or not isinstance(b, int):
            issues['malformed'].append(f'Label {i}: indices must be ints, got a={a} b={b}')
        elif a >= b:
            issues['malformed'].append(f'Label {i}: expected a_idx < b_idx, got {a} >= {b}')
        elif a < 0 or b >= K_CANDIDATES:
            issues['malformed'].append(f'Label {i}: indices out of range [0,{K_CANDIDATES}), got ({a},{b})')

        t = label.get('label_time_s')
        if not isinstance(t, (int, float)) or t < 0:
            issues['malformed'].append(f'Label {i}: bad label_time_s={t}')

    # --- 2. Group by task ---
    by_task = defaultdict(list)
    for label in labels:
        by_task[label['task_id']].append(label)

    for task_id, task_labels in by_task.items():
        seed = task_labels[0].get('task_seed', '?')
        tag = f'[{seed}]'

        # --- 2a. Duplicate detection ---
        pair_counts = defaultdict(list)
        for label in task_labels:
            key = (label['candidate_a_idx'], label['candidate_b_idx'])
            pair_counts[key].append(label)

        for key, group in pair_counts.items():
            if len(group) > 1:
                prefs = [l['preference'] for l in group]
                ids = [l['pair_id'][:8] for l in group]
                issues['duplicates'].append(
                    f'{tag} Pair ({key[0]},{key[1]}) labeled {len(group)}x '
                    f'with preferences {prefs} (ids: {ids})'
                )

        # --- 2b. Missing pairs ---
        is_skipped_task = any(l['preference'] == 'SKIP_TASK' for l in task_labels)
        if not is_skipped_task:
            covered = {(l['candidate_a_idx'], l['candidate_b_idx']) for l in task_labels}
            missing = EXPECTED_PAIRS - covered
            if missing:
                issues['missing_pairs'].append(
                    f'{tag} Missing pairs: {sorted(missing)}'
                )

        # --- 2c. Cycle detection (hard + soft) ---
        # Resolve duplicates: take the latest label per pair
        latest = {}
        for label in task_labels:
            key = (label['candidate_a_idx'], label['candidate_b_idx'])
            if key not in latest or label['timestamp'] > latest[key]['timestamp']:
                latest[key] = label

        # Build two graphs:
        #   strict[x] = {y, ...}  means x strictly beats y
        #   ge[x]     = {y, ...}  means x >= y (beats or ties)
        strict = defaultdict(set)
        ge = defaultdict(set)
        for (a, b), label in latest.items():
            pref = label['preference']
            if pref == 'A':
                strict[a].add(b)
                ge[a].add(b)
            elif pref == 'B':
                strict[b].add(a)
                ge[b].add(a)
            elif pref == 'TIE':
                ge[a].add(b)
                ge[b].add(a)

        all_nodes = set()
        for g in (strict, ge):
            for k, vs in g.items():
                all_nodes.add(k)
                all_nodes.update(vs)

        # Hard cycles: cycles using only strict edges
        hard = _find_cycles(strict, all_nodes)
        for cycle in hard:
            chain = ' > '.join(str(c) for c in cycle) + ' > ' + str(cycle[0])
            issues['hard_cycles'].append(f'{tag} {chain}')

        # Soft cycles: cycles in ge graph that have at least one strict edge
        # but aren't pure-strict (those are already reported as hard)
        soft = _find_cycles(ge, all_nodes)
        hard_set = {tuple(c) for c in hard}
        for cycle in soft:
            if tuple(cycle) in hard_set:
                continue
            # Check: does this cycle contain at least one strict edge?
            has_strict = False
            for i in range(len(cycle)):
                src = cycle[i]
                dst = cycle[(i + 1) % len(cycle)]
                if dst in strict.get(src, set()):
                    has_strict = True
                    break
            if not has_strict:
                continue  # Pure tie cycle — not a violation

            # Build annotated chain: 0 > 1 == 2 > 0
            parts = []
            for i in range(len(cycle)):
                src = cycle[i]
                dst = cycle[(i + 1) % len(cycle)]
                op = '>' if dst in strict.get(src, set()) else '=='
                parts.append(f'{src} {op}')
            chain = ' '.join(parts) + ' ' + str(cycle[0])
            issues['soft_cycles'].append(f'{tag} {chain}')

    return issues


def _find_cycles(graph: dict, nodes: set) -> list[list[int]]:
    """Find all minimal directed cycles via DFS."""
    cycles = []
    visited = set()
    path = []
    on_stack = set()

    def dfs(node):
        visited.add(node)
        path.append(node)
        on_stack.add(node)

        for neighbor in sorted(graph.get(node, [])):
            if neighbor not in visited:
                dfs(neighbor)
            elif neighbor in on_stack:
                idx = path.index(neighbor)
                cycle = path[idx:]
                # Normalize: start from smallest node
                min_idx = cycle.index(min(cycle))
                cycle = cycle[min_idx:] + cycle[:min_idx]
                if cycle not in cycles:
                    cycles.append(cycle)

        path.pop()
        on_stack.remove(node)

    for node in sorted(nodes):
        if node not in visited:
            dfs(node)

    return cycles


def main():
    if not LABELS_PATH.exists():
        print(f'No labels file at {LABELS_PATH}')
        sys.exit(1)

    labels = json.loads(LABELS_PATH.read_text())
    print(f'Loaded {len(labels)} labels\n')

    issues = verify(labels)

    total = sum(len(v) for v in issues.values())
    if total == 0:
        print('All clean - no issues found.')
        return

    for category, items in issues.items():
        if items:
            header = category.upper().replace('_', ' ')
            print(f'--- {header} ({len(items)}) ---')
            for item in items:
                print(f'  {item}')
            print()

    print(f'Total issues: {total}')
    sys.exit(1)


if __name__ == '__main__':
    main()
