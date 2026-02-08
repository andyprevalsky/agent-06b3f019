"""Expansion pipeline: grows task pool from spawn_sub_agent goals in labeled decompositions.

Flow:
  1. Mine spawn_sub_agent goals from candidates of LABELED tasks only
  2. Deduplicate against existing tasks and within-batch
  3. Run Clarifar on each new seed → ClarifiedTask
  4. Cache results to clarified_tasks/ directory

Also provides generate_and_cache_candidates() to run decomposer on uncached tasks.
"""

import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import List

from ..types import ClarifiedTask, DecompositionCandidate

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / 'data'
TASKS_DIR = DATA_DIR / 'clarified_tasks'
STATE_PATH = DATA_DIR / 'labeler_state.json'
LABELS_PATH = DATA_DIR / 'preference_labels.json'
EXPANDED_PREFIX = 'E_'


def _get_labeled_task_ids(labels_path: Path) -> set[str]:
    """Get task_ids that have at least one label in preference_labels.json."""
    if not labels_path.exists():
        return set()
    with open(labels_path) as f:
        labels = json.load(f)
    return {l['task_id'] for l in labels}


def _build_task_id_to_filename(tasks_dir: Path) -> dict[str, str]:
    """Build task_id → filename mapping from clarified task files."""
    mapping = {}
    for path in tasks_dir.glob('*.json'):
        with open(path) as f:
            task = json.load(f)
        mapping[task['id']] = path.name
    return mapping


def extract_expansion_seeds(
    state_path: str | Path = STATE_PATH,
    labels_path: str | Path = LABELS_PATH,
    tasks_dir: str | Path = TASKS_DIR,
) -> list[str]:
    """Extract unique spawn_sub_agent goals from labeled decompositions only.

    Only mines from candidates whose tasks have at least one label in
    preference_labels.json. Only collects goals with tool_name == 'spawn_sub_agent'
    (not spawn_browser_agent or other spawn tools).
    """
    state_path = Path(state_path)
    labels_path = Path(labels_path)
    tasks_dir = Path(tasks_dir)

    with open(state_path) as f:
        state = json.load(f)

    candidates_cache = state.get('candidates_cache', {})
    labeled_ids = _get_labeled_task_ids(labels_path)
    id_to_file = _build_task_id_to_filename(tasks_dir)

    # Invert: filename → task_id
    file_to_id = {v: k for k, v in id_to_file.items()}

    goals = set()
    for filename, candidates in candidates_cache.items():
        # Only mine from tasks that have labels
        task_id = file_to_id.get(filename)
        if task_id is None or task_id not in labeled_ids:
            continue

        for candidate in candidates:
            if candidate is None:
                continue
            for task in candidate.get('tasks', []):
                tool = task.get('tool_name', '')
                if tool == 'spawn_sub_agent':
                    goal = task.get('goal', '').strip()
                    if goal:
                        goals.add(goal)

    return sorted(goals)


def _get_existing_seeds(tasks_dir: Path) -> set[str]:
    """Load raw_seed from all existing clarified task files."""
    seeds = set()
    for path in tasks_dir.glob('*.json'):
        with open(path) as f:
            task = json.load(f)
        seeds.add(task.get('raw_seed', '').strip().lower())
    return seeds


def _make_expanded_filename(seed: str, idx: int) -> str:
    """Generate filename for an expanded task."""
    clean = seed[:60].replace(' ', '_').replace('/', '_').replace('\\', '_')
    clean = ''.join(c for c in clean if c.isalnum() or c == '_')
    return f'{EXPANDED_PREFIX}{idx:03d}_{clean}.json'


async def expand_tasks(
    existing_tasks: List[ClarifiedTask],
    n: int = 10,
    tasks_dir: str | Path = TASKS_DIR,
    state_path: str | Path = STATE_PATH,
    labels_path: str | Path = LABELS_PATH,
) -> List[ClarifiedTask]:
    """Generate new clarified tasks from spawn_sub_agent goals.

    1. Extracts spawn_sub_agent goals from labeled decompositions
    2. Deduplicates against existing tasks and within-batch
    3. Runs Clarifar on each new seed (skips if cached file exists)
    4. Returns new ClarifiedTasks
    """
    from .clarifar import clarifar

    tasks_dir = Path(tasks_dir)
    seeds = extract_expansion_seeds(state_path, labels_path, tasks_dir)
    existing_seeds = _get_existing_seeds(tasks_dir)

    # Also include seeds from the existing_tasks arg
    for t in existing_tasks:
        existing_seeds.add(t.raw_seed.strip().lower())

    # Filter to truly new seeds (dedup against existing + within-batch)
    new_seeds = []
    seen = set(existing_seeds)
    for s in seeds:
        key = s.strip().lower()
        if key not in seen:
            seen.add(key)
            new_seeds.append(s)
    new_seeds = new_seeds[:n]

    logger.info(f'Expansion: {len(seeds)} total spawn_sub_agent goals, {len(new_seeds)} new after dedup (cap {n})')

    results = []
    for idx, seed in enumerate(new_seeds):
        filename = _make_expanded_filename(seed, idx)
        filepath = tasks_dir / filename

        # Cache check
        if filepath.exists():
            logger.info(f'  Skipping (cached): {filename}')
            with open(filepath) as f:
                data = json.load(f)
            results.append(ClarifiedTask(
                id=data['id'],
                raw_seed=data['raw_seed'],
                agent_context=data['agent_context'],
                set_plan_args=data['set_plan_args'],
            ))
            continue

        logger.info(f'  Clarifying ({idx + 1}/{len(new_seeds)}): {seed[:80]}')
        try:
            task = await clarifar(seed)
            with open(filepath, 'w') as f:
                json.dump({
                    'id': task.id,
                    'raw_seed': task.raw_seed,
                    'agent_context': task.agent_context,
                    'set_plan_args': task.set_plan_args,
                }, f, indent=2)
            results.append(task)
        except Exception as e:
            logger.error(f'  Failed to clarify "{seed[:60]}": {e}')
            continue

    return results


async def expand_candidates(
    task: ClarifiedTask,
    n: int = 4,
) -> List[DecompositionCandidate]:
    """Generate decomposition candidates for a task."""
    from .decomposer import decompose_k
    return await decompose_k(task, k=n)


def _serialize_candidate(c: DecompositionCandidate) -> dict:
    """Serialize a DecompositionCandidate to dict for caching.

    Matches the format used by labeler.py's _serialize_candidate.
    """
    pr = c.planner_response
    return {
        'title': pr.title,
        'content': pr.content,
        'tasks': [
            {
                'goal': t.goal,
                'tool_name': t.tool_name.value if hasattr(t.tool_name, 'value') else t.tool_name,
                'depends_on': t.depends_on,
            }
            for t in pr.tasks
        ],
        'dependencies_graph': [
            {'task_idx': d.task_idx, 'depends_on': d.depends_on}
            for d in pr.dependencies_graph
        ],
        'join': pr.join,
        'validation_errors': [{'type': e.type, 'detail': e.detail} for e in c.validation_errors],
        'me': asdict(c.me) if c.me else None,
        'ce': asdict(c.ce) if c.ce else None,
        'complexity': asdict(c.complexity) if c.complexity else None,
    }


async def generate_and_cache_candidates(
    tasks: List[ClarifiedTask],
    state_path: str | Path = STATE_PATH,
    k: int = 4,
) -> dict[str, list]:
    """Run decomposer + evaluators on tasks that don't have cached candidates.

    Reads candidates_cache from labeler_state.json, runs data generation
    only for tasks missing from cache, saves results back.

    Returns:
        dict mapping task_file → list of serialized candidate dicts.
    """
    from .data_generation import generate_candidates

    state_path = Path(state_path)
    with open(state_path) as f:
        state = json.load(f)

    candidates_cache = state.get('candidates_cache', {})
    tasks_dir = state_path.parent / 'clarified_tasks'

    id_to_file = {}
    for path in tasks_dir.glob('*.json'):
        with open(path) as f:
            data = json.load(f)
        id_to_file[data['id']] = path.name

    new_count = 0
    for task in tasks:
        filename = id_to_file.get(task.id)
        if filename is None:
            logger.warning(f'No file found for task {task.id}, skipping')
            continue

        cached = candidates_cache.get(filename, [])
        non_null = [c for c in cached if c is not None]
        if len(non_null) >= k:
            logger.info(f'  Cached ({len(non_null)} candidates): {filename}')
            continue

        logger.info(f'  Generating {k} candidates for: {filename}')
        try:
            candidates = await generate_candidates(task, k=k)
            candidates_cache[filename] = [_serialize_candidate(c) for c in candidates]
            new_count += 1
        except Exception as e:
            logger.error(f'  Failed to generate for {filename}: {e}')
            continue

    if new_count > 0:
        state['candidates_cache'] = candidates_cache
        with open(state_path, 'w') as f:
            json.dump(state, f, indent=2)
        logger.info(f'Saved {new_count} new candidate sets to cache')

    return candidates_cache
