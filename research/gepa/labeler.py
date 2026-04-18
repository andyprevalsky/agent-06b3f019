"""GEPA Labeler: FastAPI server for preference labeling of decomposition pairs.

Generates K=4 candidates per clarified task, creates C(4,2)=6 pairs,
pre-computes ME/CE/CX evaluations, and serves a clean UI for rapid labeling.

Progressive generation: candidates + evals stream in as they complete.
Only generates current task + prefetches next task.

Run: cd marseille && python -m research.gepa.labeler
"""

import asyncio
import json
import logging
import os
import sys
import time
from dataclasses import asdict, dataclass, field
from itertools import combinations
from pathlib import Path
from typing import Any
from uuid import uuid4

# Setup paths before any agents imports
os.chdir(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, 'agents')
sys.path.insert(0, '.')

from dotenv import load_dotenv  # noqa: E402

load_dotenv('agents/.env')

import uvicorn  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import HTMLResponse  # noqa: E402

from research.gepa.evaluators import evaluate_ce, evaluate_complexity, evaluate_me  # noqa: E402
from research.gepa.pipelines.decomposer import (  # noqa: E402
    K_CANDIDATES,
    MODEL,
    TEMPERATURES,
    decompose_once,
)
from research.gepa.types import ClarifiedTask, DecompositionCandidate  # noqa: E402

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

# ─── COST ─────────────────────────────────────────────────────────

COST_INPUT = 2.35 / 1_000_000  # $2.35/M tokens (Rose Ultra avg: Opus4.6+GPT5.2+Gemini3+Kimi)
COST_OUTPUT = 13.50 / 1_000_000  # $13.50/M tokens (Rose Ultra avg)


def _calc_cost(usage: dict) -> float:
    return (
        usage.get('prompt_tokens', 0) * COST_INPUT + usage.get('completion_tokens', 0) * COST_OUTPUT
    )


# ─── PATHS ───────────────────────────────────────────────────────

DATA_DIR = Path('research/gepa/data')
TASKS_DIR = DATA_DIR / 'clarified_tasks'
STATE_PATH = DATA_DIR / 'labeler_state.json'
LABELS_PATH = DATA_DIR / 'preference_labels.json'

# ─── STATE ───────────────────────────────────────────────────────


@dataclass
class LabelerState:
    task_files: list[str] = field(default_factory=list)
    current_task_idx: int = 0
    current_pair_idx: int = 0
    candidates_cache: dict[str, list[dict | None]] = field(default_factory=dict)
    task_costs: dict[str, float] = field(default_factory=dict)  # task_file -> $ cost
    labels: list[dict] = field(default_factory=list)
    session_start: float = 0.0
    session_label_count: int = 0
    total_label_count: int = 0
    total_label_time: float = 0.0


def _reconcile_labels(s: LabelerState):
    """Advance position past already-labeled pairs using preference_labels.json as source of truth."""
    if not LABELS_PATH.exists():
        return
    disk_labels = json.loads(LABELS_PATH.read_text())
    if not disk_labels:
        return

    logger.info(f'Reconciling: {len(disk_labels)} labels on disk vs {len(s.labels)} in state')
    s.labels = disk_labels
    s.total_label_count = len(disk_labels)
    s.total_label_time = sum(
        l.get('label_time_s', 0) for l in disk_labels if l.get('preference') != 'SKIP'
    )

    # Build set of already-labeled (task_id, frozenset(a_idx, b_idx)) — order-independent
    labeled = set()
    for label in disk_labels:
        labeled.add(
            (label['task_id'], frozenset((label['candidate_a_idx'], label['candidate_b_idx'])))
        )

    # Walk tasks to find first unlabeled pair
    for task_idx, task_file in enumerate(s.task_files):
        task_data = json.loads((TASKS_DIR / task_file).read_text())
        task_id = task_data['id']
        slots = s.candidates_cache.get(task_file, [])
        n_valid = len([sl for sl in slots if sl is not None]) if slots else K_CANDIDATES
        pairs = _get_pairs(n_valid)

        for pair_idx, (a, b) in enumerate(pairs):
            if (task_id, frozenset((a, b))) not in labeled:
                s.current_task_idx = task_idx
                s.current_pair_idx = pair_idx
                logger.info(f'Resuming at task {task_idx} ({task_file}), pair {pair_idx}')
                return

    # All pairs labeled
    s.current_task_idx = len(s.task_files)
    s.current_pair_idx = 0
    logger.info(f'All pairs labeled ({len(disk_labels)} labels)')


def _load_state() -> LabelerState:
    if STATE_PATH.exists():
        data = json.loads(STATE_PATH.read_text())
        s = LabelerState(**data)
    else:
        task_files = sorted([f.name for f in TASKS_DIR.glob('*.json')])
        s = LabelerState(task_files=task_files)
    _reconcile_labels(s)
    s.session_start = time.time()
    s.session_label_count = 0
    return s


def _save_state():
    STATE_PATH.write_text(json.dumps(asdict(state), indent=2, default=str))


def _save_labels():
    LABELS_PATH.write_text(json.dumps(state.labels, indent=2, default=str))


def _load_task(filename: str) -> ClarifiedTask:
    data = json.loads((TASKS_DIR / filename).read_text())
    return ClarifiedTask(**data)


def _serialize_candidate(c: DecompositionCandidate) -> dict:
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
            {'task_idx': d.task_idx, 'depends_on': d.depends_on} for d in pr.dependencies_graph
        ],
        'join': pr.join,
        'validation_errors': [{'type': e.type, 'detail': e.detail} for e in c.validation_errors],
        'me': asdict(c.me) if c.me else None,
        'ce': asdict(c.ce) if c.ce else None,
        'complexity': asdict(c.complexity) if c.complexity else None,
    }


def _canonicalize(a_idx: int, b_idx: int, preference: str) -> tuple:
    """Ensure a_idx < b_idx for storage. Flips preference if indices are swapped."""
    if a_idx <= b_idx:
        return a_idx, b_idx, preference
    flip = {'A': 'B', 'B': 'A', 'TIE': 'TIE', 'SKIP': 'SKIP', 'SKIP_TASK': 'SKIP_TASK'}
    return b_idx, a_idx, flip[preference]


def _get_pairs(n: int) -> list[tuple]:
    """Return pairs in chain order so consecutive pairs share one element.

    Side-stable: if a candidate appears in consecutive pairs, it stays on
    the same side (A or B) it was on in the previous pair.
    """
    if n < 2:
        return []
    remaining = list(combinations(range(n), 2))
    chain = [remaining.pop(0)]
    while remaining:
        last = chain[-1]
        idx = next((i for i, p in enumerate(remaining) if p[0] in last or p[1] in last), None)
        if idx is None:
            break
        chain.append(remaining.pop(idx))
    # Enforce side stability: shared candidate keeps its side
    for i in range(1, len(chain)):
        a, b = chain[i]
        prev_a, prev_b = chain[i - 1]
        if a == prev_b or b == prev_a:
            chain[i] = (b, a)
    return chain


# ─── PROGRESSIVE GENERATION ──────────────────────────────────────

# In-flight generation tracking: task_file -> True if generation running
_generating: dict[str, bool] = {}
# Generation version: incremented on edit to invalidate stale generation runs
_gen_version: dict[str, int] = {}


def _is_ready(task_file: str) -> bool:
    """Check if all 4 candidates + all evals are done for a task."""
    slots = state.candidates_cache.get(task_file, [])
    if len(slots) < K_CANDIDATES:
        return False
    for c in slots:
        if c is None:
            return False
        # If structurally valid, evals must be done
        if not c.get('validation_errors') and (
            c.get('me') is None or c.get('ce') is None or c.get('complexity') is None
        ):
            return False
    return True


async def _generate_for_task(task_file: str):
    """Generate candidates + evals progressively, storing each as it completes."""
    if _generating.get(task_file):
        return
    if _is_ready(task_file):
        return

    _generating[task_file] = True
    my_version = _gen_version.get(task_file, 0)
    logger.info(f'Starting generation for {task_file} (v{my_version})')

    def _stale():
        return _gen_version.get(task_file, 0) != my_version

    try:
        task = _load_task(task_file)
        task_cost = state.task_costs.get(task_file, 0.0)

        # Initialize slots
        if (
            task_file not in state.candidates_cache
            or len(state.candidates_cache[task_file]) < K_CANDIDATES
        ):
            state.candidates_cache[task_file] = [None] * K_CANDIDATES

        slots = state.candidates_cache[task_file]

        # Phase 1: Generate candidates (parallel, store each as it lands)
        temps = TEMPERATURES[:K_CANDIDATES]

        max_retries = 3

        async def gen_one(idx: int, temp: float):
            nonlocal task_cost
            if slots[idx] is not None and not slots[idx].get('_failed'):
                return  # Already cached (resume)
            for attempt in range(max_retries):
                try:
                    logger.info(
                        f'  [{task_file}] Generating candidate {idx} (seed={idx}, temp={temp}) attempt {attempt + 1}/{max_retries}'
                    )
                    candidate, usage = await decompose_once(task, MODEL, temp, model_seed=idx)
                    task_cost += _calc_cost(usage)
                    slots[idx] = _serialize_candidate(candidate)
                    logger.info(
                        f'  [{task_file}] Candidate {idx} done: {candidate.planner_response.title[:60]}'
                    )
                    return
                except Exception as e:
                    logger.error(
                        f'  [{task_file}] Candidate {idx} attempt {attempt + 1} failed: {e}'
                    )
                    if attempt < max_retries - 1:
                        await asyncio.sleep(1)
            # All retries exhausted
            slots[idx] = {
                'title': 'Generation failed',
                'content': 'All retries exhausted',
                'tasks': [],
                'dependencies_graph': [],
                'join': 'all',
                'validation_errors': [
                    {'type': 'GENERATION_ERROR', 'detail': 'Failed after 3 retries'}
                ],
                'me': None,
                'ce': None,
                'complexity': None,
                '_failed': True,
            }

        await asyncio.gather(*[gen_one(i, t) for i, t in enumerate(temps)])

        if _stale():
            logger.info(f'Generation for {task_file} cancelled (stale after decomposition)')
            return

        # Phase 2: Run evals on each valid candidate (parallel per candidate, sequential across)
        async def eval_one(idx: int):
            nonlocal task_cost
            c = slots[idx]
            if c is None or c.get('validation_errors'):
                return  # Skip invalid
            if (
                c.get('me') is not None
                and c.get('ce') is not None
                and c.get('complexity') is not None
            ):
                return  # Already evaluated (resume)

            goal = task.raw_seed
            context = task.agent_context
            # Reconstruct PlannerResponse for evaluators
            from helpers.tool_schemas import PlannerResponse

            pr = PlannerResponse.model_validate(
                {
                    'title': c['title'],
                    'content': c['content'],
                    'tasks': c['tasks'],
                    'dependencies_graph': c['dependencies_graph'],
                    'join': c['join'],
                }
            )

            async def run_eval(name, fn):
                nonlocal task_cost
                try:
                    logger.info(f'  [{task_file}] Eval {name} for candidate {idx}')
                    result, usage = await fn(goal, pr, agent_context=context)
                    task_cost += _calc_cost(usage)
                    c[name] = asdict(result)
                    logger.info(
                        f'  [{task_file}] Eval {name} candidate {idx}: passed={result.passed}'
                    )
                except Exception as e:
                    logger.error(f'  [{task_file}] Eval {name} candidate {idx} failed: {e}')
                    c[name] = {'passed': False, 'score': 0.0, 'reasoning': f'Error: {e}'}

            await asyncio.gather(
                run_eval('me', evaluate_me),
                run_eval('ce', evaluate_ce),
                run_eval('complexity', evaluate_complexity),
            )

        await asyncio.gather(*[eval_one(i) for i in range(K_CANDIDATES)])

        if _stale():
            logger.info(f'Generation for {task_file} cancelled (stale after evals)')
            return

        state.task_costs[task_file] = task_cost
        _save_state()
        logger.info(f'Generation complete for {task_file} (cost: ${task_cost:.4f})')

    except Exception as e:
        logger.error(f'Generation failed for {task_file}: {e}')
    finally:
        _generating[task_file] = False


# ─── APP ─────────────────────────────────────────────────────────

app = FastAPI(title='GEPA Labeler')
state: LabelerState = _load_state()
_bg_tasks: dict[str, asyncio.Task] = {}


def _kick_generation(task_file: str):
    """Start background generation if not already running."""
    if task_file in _bg_tasks and not _bg_tasks[task_file].done():
        return
    if _is_ready(task_file):
        return
    _bg_tasks[task_file] = asyncio.create_task(_generate_for_task(task_file))


@app.get('/', response_class=HTMLResponse)
async def index():
    return LABELER_HTML


@app.get('/api/state')
async def get_state():
    total_tasks = len(state.task_files)
    total_pairs = total_tasks * 6
    session_time = time.time() - state.session_start if state.session_start else 0
    session_avg = session_time / state.session_label_count if state.session_label_count > 0 else 0
    overall_avg = (
        state.total_label_time / state.total_label_count if state.total_label_count > 0 else 0
    )
    total_cost = sum(state.task_costs.values())
    return {
        'total_tasks': total_tasks,
        'total_pairs': total_pairs,
        'labeled': state.total_label_count,
        'current_task_idx': state.current_task_idx,
        'current_pair_idx': state.current_pair_idx,
        'session_label_count': state.session_label_count,
        'session_avg_s': round(session_avg, 1),
        'overall_avg_s': round(overall_avg, 1),
        'total_cost': round(total_cost, 4),
    }


@app.get('/api/current')
async def get_current():
    """Return immediately with whatever data is available. Frontend polls."""
    if state.current_task_idx >= len(state.task_files):
        return {'done': True, 'message': 'All tasks labeled!'}

    task_file = state.task_files[state.current_task_idx]
    task = _load_task(task_file)

    # Kick off generation (no-op if already running or done)
    _kick_generation(task_file)

    # Prefetch next 3 tasks once current is done
    if _is_ready(task_file):
        for offset in range(1, 4):
            lookahead_idx = state.current_task_idx + offset
            if lookahead_idx < len(state.task_files):
                _kick_generation(state.task_files[lookahead_idx])

    slots = state.candidates_cache.get(task_file, [None] * K_CANDIDATES)
    ready_count = sum(1 for s in slots if s is not None)
    all_ready = _is_ready(task_file)

    # Compute pairs from candidate slots
    pairs = _get_pairs(len(slots)) if all_ready else []

    # Current pair info
    pair_idx = state.current_pair_idx
    candidate_a = None
    candidate_b = None
    a_idx = None
    b_idx = None
    if all_ready and pairs and pair_idx < len(pairs):
        a_idx, b_idx = pairs[pair_idx]
        candidate_a = slots[a_idx]
        candidate_b = slots[b_idx]

    return {
        'done': False,
        'generating': not all_ready,
        'candidates_ready': ready_count,
        'candidates_total': K_CANDIDATES,
        'task_idx': state.current_task_idx,
        'pair_idx': pair_idx,
        'total_pairs_this_task': len(pairs) if all_ready else 6,
        'task': {
            'id': task.id,
            'raw_seed': task.raw_seed,
            'agent_context': task.agent_context,
        },
        'candidates': slots,  # All 4 slots (None = pending)
        'candidate_a': candidate_a,
        'candidate_b': candidate_b,
        'candidate_a_idx': a_idx,
        'candidate_b_idx': b_idx,
    }


def _labeled_set() -> set:
    """Build set of (task_id, frozenset(a, b)) from current labels."""
    return {
        (l['task_id'], frozenset((l['candidate_a_idx'], l['candidate_b_idx'])))
        for l in state.labels
    }


def _advance_pair():
    labeled = _labeled_set()
    # Move forward one step first, then keep skipping already-labeled pairs
    state.current_pair_idx += 1
    while state.current_task_idx < len(state.task_files):
        task_file = state.task_files[state.current_task_idx]
        task_data = json.loads((TASKS_DIR / task_file).read_text())
        task_id = task_data['id']
        slots = state.candidates_cache.get(task_file, [])
        non_none = [s for s in slots if s is not None]
        pairs = _get_pairs(len(non_none))
        # Scan from current_pair_idx forward
        while state.current_pair_idx < len(pairs):
            a, b = pairs[state.current_pair_idx]
            if (task_id, frozenset((a, b))) not in labeled:
                _save_state()
                return  # Found an unlabeled pair
            state.current_pair_idx += 1
        # All pairs in this task done, move to next task
        state.current_task_idx += 1
        state.current_pair_idx = 0
    _save_state()


@app.post('/api/label')
async def submit_label(body: dict[str, Any]):
    preference = body.get('preference')
    label_time = body.get('label_time_s', 0)
    if preference not in ('A', 'B', 'TIE', 'SKIP'):
        raise HTTPException(400, 'preference must be A, B, TIE, or SKIP')

    task_file = state.task_files[state.current_task_idx]
    task = _load_task(task_file)
    slots = state.candidates_cache.get(task_file, [])
    non_none = [s for s in slots if s is not None]
    pairs = _get_pairs(len(non_none))
    a_idx, b_idx = pairs[state.current_pair_idx]

    # Canonicalize: always store (min, max) and flip preference if swapped
    store_a, store_b, store_pref = _canonicalize(a_idx, b_idx, preference)

    state.labels.append(
        {
            'pair_id': str(uuid4()),
            'task_id': task.id,
            'task_seed': task.raw_seed,
            'candidate_a_idx': store_a,
            'candidate_b_idx': store_b,
            'preference': store_pref,
            'label_time_s': label_time,
            'timestamp': time.time(),
        }
    )
    state.total_label_count += 1
    state.session_label_count += 1
    if preference != 'SKIP':
        state.total_label_time += label_time

    _advance_pair()
    _save_labels()
    _save_state()
    return {'ok': True, 'labeled': state.total_label_count}


@app.post('/api/toggle-eval')
async def toggle_eval(body: dict[str, Any]):
    eval_type = body.get('eval_type')
    side = body.get('side')
    new_passed = body.get('passed')
    if eval_type not in ('me', 'ce', 'complexity'):
        raise HTTPException(400, 'eval_type must be me, ce, or complexity')

    task_file = state.task_files[state.current_task_idx]
    slots = state.candidates_cache.get(task_file, [])
    pairs = _get_pairs(len([s for s in slots if s is not None]))
    a_idx, b_idx = pairs[state.current_pair_idx]
    target_idx = a_idx if side == 'a' else b_idx
    if slots[target_idx] and slots[target_idx].get(eval_type):
        slots[target_idx][eval_type]['passed'] = new_passed
        _save_state()
    return {'ok': True}


@app.get('/api/prev')
async def go_prev():
    if state.current_pair_idx > 0:
        state.current_pair_idx -= 1
    elif state.current_task_idx > 0:
        state.current_task_idx -= 1
        task_file = state.task_files[state.current_task_idx]
        slots = state.candidates_cache.get(task_file, [])
        non_none = [s for s in slots if s is not None]
        pairs = _get_pairs(len(non_none))
        state.current_pair_idx = max(0, len(pairs) - 1)
    _save_state()
    return {'ok': True}


@app.post('/api/skip-task')
async def skip_task():
    """Skip all remaining pairs for the current task (marks as SKIP_TASK)."""
    if state.current_task_idx >= len(state.task_files):
        raise HTTPException(400, 'No task to skip')
    task_file = state.task_files[state.current_task_idx]
    task = _load_task(task_file)
    slots = state.candidates_cache.get(task_file, [])
    non_none = [s for s in slots if s is not None]
    pairs = _get_pairs(len(non_none))

    # Record SKIP_TASK for all remaining pairs
    for pi in range(state.current_pair_idx, len(pairs)):
        a_idx, b_idx = pairs[pi]
        store_a, store_b, _ = _canonicalize(a_idx, b_idx, 'SKIP_TASK')
        state.labels.append(
            {
                'pair_id': str(uuid4()),
                'task_id': task.id,
                'task_seed': task.raw_seed,
                'candidate_a_idx': store_a,
                'candidate_b_idx': store_b,
                'preference': 'SKIP_TASK',
                'label_time_s': 0,
                'timestamp': time.time(),
            }
        )
        state.total_label_count += 1
        state.session_label_count += 1

    state.current_task_idx += 1
    state.current_pair_idx = 0
    _save_labels()
    _save_state()
    logger.info(f'Skipped task {task.raw_seed} ({task.id})')
    return {'ok': True, 'skipped_task': task.raw_seed}


@app.post('/api/edit-task')
async def edit_task(body: dict[str, Any]):
    """Edit current task's raw_seed and/or agent_context, persist to disk, and regenerate decompositions."""
    if state.current_task_idx >= len(state.task_files):
        raise HTTPException(400, 'No task to edit')

    task_file = state.task_files[state.current_task_idx]
    task_path = TASKS_DIR / task_file
    task_data = json.loads(task_path.read_text())

    new_seed = body.get('raw_seed')
    new_context = body.get('agent_context')

    if new_seed is not None:
        task_data['raw_seed'] = new_seed
    if new_context is not None:
        task_data['agent_context'] = new_context

    task_path.write_text(json.dumps(task_data, indent=2))
    logger.info(
        f'Edited task {task_file}: seed={new_seed is not None}, context={new_context is not None}'
    )

    # Invalidate any in-flight generation and clear cache
    _gen_version[task_file] = _gen_version.get(task_file, 0) + 1
    if task_file in _bg_tasks and not _bg_tasks[task_file].done():
        _bg_tasks[task_file].cancel()
    _generating.pop(task_file, None)
    state.candidates_cache[task_file] = [None] * K_CANDIDATES
    state.current_pair_idx = 0
    _save_state()

    # Kick off fresh generation
    _kick_generation(task_file)

    return {'ok': True}


# ─── HTML ────────────────────────────────────────────────────────

LABELER_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GEPA Labeler</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html { height: 100%; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 12px 16px; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
.header { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #333; margin-bottom: 8px; flex-shrink: 0; }
.header h1 { font-size: 18px; color: #fff; }
.stats { font-size: 13px; color: #888; display: flex; gap: 16px; }
.stats span { color: #aaa; }
.timer { color: #4fc3f7 !important; font-variant-numeric: tabular-nums; }

#content { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }

.seed-bar { background: #1a1a2e; border: 1px solid #333; border-radius: 6px; padding: 8px 16px; margin-bottom: 8px; flex-shrink: 0; }
.seed-bar .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
.seed-bar .seed { font-size: 16px; color: #fff; margin-top: 2px; }

.context-toggle { font-size: 12px; color: #4fc3f7; cursor: pointer; margin-bottom: 6px; display: inline-block; user-select: none; flex-shrink: 0; }
.context-panel { display: none; background: #111; border: 1px solid #333; border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; flex-shrink: 0; }
.context-panel.open { display: block; }
.ctx-msg { margin-bottom: 4px; padding: 4px 8px; border-radius: 4px; }
.ctx-msg.user { background: #1a2a1a; border-left: 3px solid #4caf50; }
.ctx-msg.editing textarea { width: 100%; min-height: 60px; background: #1a2a1a; color: #ccc; border: 1px solid #4caf50; border-radius: 4px; padding: 6px; font-family: inherit; font-size: 12px; resize: vertical; }
.ctx-role { font-size: 10px; color: #888; text-transform: uppercase; }
.seed-edit-input { background: #111; color: #fff; border: 1px solid #4fc3f7; border-radius: 4px; padding: 4px 8px; font-size: 16px; width: 100%; font-family: inherit; }
.btn-edit { color: #4fc3f7; border-color: #4fc3f7; font-size: 12px; padding: 4px 10px; }
.btn-edit:hover { background: #4fc3f710; }
.btn-save-edit { color: #4caf50; border-color: #4caf50; font-size: 12px; padding: 4px 10px; }
.btn-save-edit:hover { background: #4caf5010; }
.btn-cancel-edit { color: #f44336; border-color: #f44336; font-size: 12px; padding: 4px 10px; }
.btn-cancel-edit:hover { background: #f4433610; }

.gen-status { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 12px 16px; margin-bottom: 8px; flex-shrink: 0; }
.gen-progress { display: flex; gap: 8px; align-items: center; }
.gen-dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #333; }
.gen-dot.done { background: #4caf50; border-color: #4caf50; }
.gen-dot.pending { border-color: #555; animation: pulse 1.5s infinite; }
.gen-dot.eval { background: #ffc107; border-color: #ffc107; }
@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
.gen-label { font-size: 12px; color: #888; margin-left: 8px; }

.pair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; flex: 1; min-height: 0; }
.candidate { background: #111; border: 2px solid #333; border-radius: 8px; padding: 12px; transition: border-color 0.2s; overflow-y: auto; }
.candidate.is-new { background: #0d1520; border-color: #1a3a5c; }
.candidate:hover { border-color: #555; }
.candidate.loading { opacity: 0.4; }
.cand-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.cand-label { font-size: 14px; font-weight: 600; }
.cand-label.a { color: #4caf50; }
.cand-label.b { color: #f44336; }

.plan-title { font-size: 15px; font-weight: 600; color: #fff; margin-bottom: 4px; }
.plan-desc-toggle { cursor: pointer; font-size: 12px; color: #666; user-select: none; margin-bottom: 4px; display: inline-block; }
.plan-desc-toggle:hover { color: #4fc3f7; }
.plan-content { font-size: 13px; color: #999; margin-bottom: 8px; line-height: 1.5; display: none; padding-left: 14px; }
.plan-content.open { display: block; }
.join-badge { display: inline-block; font-size: 14px; padding: 4px 10px; border-radius: 4px; background: #1a2a3a; color: #4fc3f7; font-weight: 500; }

.task-list { margin: 8px 0; }
.task-item { padding: 5px 0; border-bottom: 1px solid #1a1a1a; }
.task-header { display: flex; gap: 8px; align-items: center; }
.task-idx { color: #888; font-size: 13px; min-width: 22px; font-weight: 600; }
.task-tool { font-size: 12px; color: #4fc3f7; background: #1a2a3a; padding: 2px 8px; border-radius: 3px; white-space: nowrap; }
.task-deps { font-size: 12px; color: #888; white-space: nowrap; margin-left: auto; }
.task-goal { color: #ccc; display: block; margin-top: 2px; padding-left: 30px; font-size: 13px; line-height: 1.4; }

.gates { margin-top: 8px; padding-top: 6px; border-top: 1px solid #222; }
.gate-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 15px; }
.gate-icon { width: 20px; text-align: center; font-size: 15px; cursor: pointer; user-select: none; }
.gate-icon:hover { opacity: 0.7; }
.gate-pass { color: #4caf50; }
.gate-fail { color: #f44336; }
.gate-label { color: #ccc; font-size: 15px; }
.gate-chevron { cursor: pointer; font-size: 11px; color: #555; user-select: none; margin-left: 4px; }
.gate-chevron:hover { color: #4fc3f7; }
.gate-reasoning { font-size: 13px; color: #888; margin-left: 28px; margin-bottom: 4px; line-height: 1.4; white-space: pre-line; display: none; }
.gate-reasoning.open { display: block; }
.gate-spinner { color: #ffc107; animation: pulse 1s infinite; }

.actions { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; flex-shrink: 0; }
.actions-center { display: flex; gap: 12px; }
.btn { padding: 10px 32px; font-size: 15px; font-weight: 600; border: 2px solid; border-radius: 6px; cursor: pointer; background: transparent; transition: all 0.15s; }
.btn:hover { transform: translateY(-1px); }
.btn:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }
.btn-a { color: #4caf50; border-color: #4caf50; }
.btn-a:hover:not(:disabled) { background: #4caf5022; }
.btn-tie { color: #ffc107; border-color: #ffc107; }
.btn-tie:hover:not(:disabled) { background: #ffc10722; }
.btn-b { color: #f44336; border-color: #f44336; }
.btn-b:hover:not(:disabled) { background: #f4433622; }
.btn-skip { color: #666; border-color: #444; font-size: 13px; padding: 8px 20px; }
.btn-skip:hover:not(:disabled) { background: #ffffff08; }
.btn-nav { color: #888; border-color: #444; font-size: 13px; padding: 8px 16px; }
.btn-nav:hover { background: #ffffff08; }

.btn-delete { color: #666; border-color: #444; font-size: 12px; padding: 6px 14px; }
.btn-delete:hover { background: #ffffff08; }
.btn-delete.armed { color: #f44336; border-color: #f44336; animation: pulse 0.6s infinite; }

.nav-row { display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }

.done { text-align: center; padding: 60px; }
.done h2 { color: #4caf50; margin-bottom: 12px; }

kbd { background: #222; border: 1px solid #444; border-radius: 3px; padding: 1px 6px; font-size: 11px; color: #888; }
.shortcuts { text-align: center; font-size: 12px; color: #555; margin-top: 8px; }
</style>
</head>
<body>

<div class="header">
  <h1>GEPA Labeler</h1>
  <div class="stats">
    <span>Progress: <span id="progress">-</span></span>
    <span>Session: <span id="session-avg">-</span>/label</span>
    <span>Overall: <span id="overall-avg">-</span>/label</span>
    <span style="color:#4caf50">$<span id="total-cost">0</span></span>
    <span class="timer" id="live-timer">0.0s</span>
  </div>
</div>

<div id="content"></div>

<script>
let labelStart = Date.now();
let timerInterval = null;
let currentData = null;
let pollInterval = null;
let isGenerating = false;

function startTimer() {
  labelStart = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    document.getElementById('live-timer').textContent =
      ((Date.now() - labelStart) / 1000).toFixed(1) + 's';
  }, 100);
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(poll, 1000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function poll() {
  try {
    const resp = await fetch('/api/current');
    const d = await resp.json();
    currentData = d;
    if (d.done) { stopPolling(); render(d); return; }
    if (d.generating) {
      render(d);
    } else {
      stopPolling();
      isGenerating = false;
      render(d);
      if (!timerInterval) startTimer();
    }
    updateStats();
  } catch(e) { console.error('poll error', e); }
}

async function updateStats() {
  const resp = await fetch('/api/state');
  const s = await resp.json();
  document.getElementById('progress').textContent = s.labeled + '/' + s.total_pairs;
  document.getElementById('session-avg').textContent = s.session_avg_s.toFixed(1) + 's';
  document.getElementById('overall-avg').textContent = s.overall_avg_s.toFixed(1) + 's';
  document.getElementById('total-cost').textContent = (s.total_cost || 0).toFixed(2);
}

let prevAIdx = null;
let prevBIdx = null;
let lastData = null;

function render(d) {
  lastData = d;
  if (d.done) {
    document.getElementById('content').innerHTML =
      '<div class="done"><h2>All Done!</h2><p>All pairs labeled.</p></div>';
    return;
  }

  const task = d.task;
  const slots = d.candidates || [];
  const generating = d.generating;
  const aNew = prevAIdx !== null && d.candidate_a_idx !== prevAIdx && d.candidate_a_idx !== prevBIdx;
  const bNew = prevBIdx !== null && d.candidate_b_idx !== prevAIdx && d.candidate_b_idx !== prevBIdx;

  let html = '';

  // Seed bar
  html += '<div class="seed-bar"><div class="label">Task ' + (d.task_idx + 1) + '/' + d.total_pairs_this_task + ' pairs';
  if (!editMode) html += ' <button class="btn btn-edit" onclick="startEdit()">Edit</button>';
  else html += ' <button class="btn btn-save-edit" onclick="saveEdit()">Save</button> <button class="btn btn-cancel-edit" onclick="cancelEdit()">Cancel</button>';
  html += '</div>';
  if (editMode) {
    html += '<div class="seed"><input class="seed-edit-input" id="edit-seed" value="' + esc(task.raw_seed).replace(/"/g, '&quot;') + '" /></div></div>';
  } else {
    html += '<div class="seed">' + esc(task.raw_seed) + '</div></div>';
  }

  // Context (user messages only, shown by default)
  const ctx = task.agent_context || [];
  const userCtx = ctx.filter(m => (m.role||'').toLowerCase() === 'user');
  if (userCtx.length > 0) {
    html += '<span class="context-toggle" onclick="toggleCtx()"><span id="ctx-arrow">&#9660;</span> Context (' + userCtx.length + ' msgs)</span>';
    html += '<div class="context-panel open" id="ctx-panel">';
    userCtx.forEach((m, i) => {
      if (editMode) {
        html += '<div class="ctx-msg user editing"><div class="ctx-role">user</div><textarea class="edit-ctx" data-idx="' + i + '">' + esc(m.content||'') + '</textarea></div>';
      } else {
        html += '<div class="ctx-msg user"><div class="ctx-role">user</div>' + esc(m.content||'') + '</div>';
      }
    });
    html += '</div>';
  }

  // Generation progress
  if (generating) {
    html += '<div class="gen-status"><div class="gen-progress">';
    for (let i = 0; i < d.candidates_total; i++) {
      const s = slots[i];
      let cls = 'pending';
      if (s) {
        const hasEvals = s.me && s.ce && s.complexity;
        cls = hasEvals ? 'done' : 'eval';
      }
      html += '<div class="gen-dot ' + cls + '"></div>';
    }
    html += '<span class="gen-label">' + d.candidates_ready + '/' + d.candidates_total + ' candidates';
    // Count evals
    let evalsDone = 0, evalsTotal = 0;
    slots.forEach(s => {
      if (s && !s.validation_errors?.length) {
        evalsTotal += 3;
        if (s.me) evalsDone++;
        if (s.ce) evalsDone++;
        if (s.complexity) evalsDone++;
      }
    });
    if (evalsTotal > 0) html += ' &middot; ' + evalsDone + '/' + evalsTotal + ' evals';
    html += '</span></div></div>';
  }

  // Pair display
  if (!generating && d.candidate_a && d.candidate_b) {
    html += '<div class="pair-grid">';
    html += renderCandidate(d.candidate_a, 'A', 'a', d.candidate_a_idx, aNew);
    html += renderCandidate(d.candidate_b, 'B', 'b', d.candidate_b_idx, bNew);
    html += '</div>';

    html += '<div class="actions">';
    html += '<button class="btn btn-a" onclick="submitLabel(\\'A\\')">A is better</button>';
    html += '<div class="actions-center"><button class="btn btn-tie" onclick="submitLabel(\\'TIE\\')">Tie</button>';
    html += '<button class="btn btn-skip" onclick="submitLabel(\\'SKIP\\')">Skip</button></div>';
    html += '<button class="btn btn-b" onclick="submitLabel(\\'B\\')">B is better</button>';
    html += '</div>';
  } else if (generating) {
    // Show whatever candidates we have so far
    html += '<div class="pair-grid">';
    const readySlots = slots.filter(s => s !== null);
    if (readySlots.length >= 1) html += renderCandidate(readySlots[0], '0', 'a', 0);
    else html += '<div class="candidate loading"><div style="text-align:center;padding:40px;color:#555">Generating...</div></div>';
    if (readySlots.length >= 2) html += renderCandidate(readySlots[1], '1', 'b', 1);
    else html += '<div class="candidate loading"><div style="text-align:center;padding:40px;color:#555">Generating...</div></div>';
    html += '</div>';

    // Show remaining candidates below if > 2
    if (readySlots.length > 2) {
      html += '<div class="pair-grid">';
      if (readySlots.length >= 3) html += renderCandidate(readySlots[2], '2', 'a', 2);
      if (readySlots.length >= 4) html += renderCandidate(readySlots[3], '3', 'b', 3);
      html += '</div>';
    }

    html += '<div class="actions">';
    html += '<button class="btn btn-a" disabled>A is better</button>';
    html += '<div class="actions-center"><button class="btn btn-tie" disabled>Tie</button>';
    html += '<button class="btn btn-skip" disabled>Skip</button></div>';
    html += '<button class="btn btn-b" disabled>B is better</button>';
    html += '</div>';
  }

  html += '<div class="nav-row">';
  html += '<button class="btn btn-nav" onclick="goPrev()">Prev</button>';
  html += '<div class="shortcuts"><kbd>Q</kbd> A &nbsp; <kbd>W</kbd> Tie &nbsp; <kbd>E</kbd> B &nbsp; <kbd>R</kbd> Skip &nbsp; <kbd>P</kbd> Prev</div>';
  html += '<span style="color:#555;font-size:12px">Pair ' + (d.pair_idx + 1) + '/' + d.total_pairs_this_task + '</span>';
  html += '<button class="btn btn-delete" id="btn-delete" onclick="deleteTask()">Delete Task</button>';
  html += '</div>';

  document.getElementById('content').innerHTML = html;
  if (d.candidate_a_idx != null) { prevAIdx = d.candidate_a_idx; prevBIdx = d.candidate_b_idx; }
}

function renderCandidate(c, label, side, idx, isNew) {
  const labelCls = side === 'a' ? 'a' : 'b';
  const candId = side + '-' + idx;
  let html = '<div class="candidate' + (isNew ? ' is-new' : '') + '">';
  html += '<div class="cand-header"><span class="cand-label ' + labelCls + '">' + label + '</span>';
  html += '<span class="join-badge">join: ' + (c.join || 'all') + '</span></div>';
  html += '<div class="plan-title">' + esc(c.title || '') + '</div>';

  // Collapsible plan description
  if (c.content) {
    const descId = 'desc-' + candId;
    html += '<span class="plan-desc-toggle" onclick="toggleDesc(\\'' + descId + '\\', this)">&#9654; description</span>';
    html += '<div class="plan-content" id="' + descId + '">' + esc(c.content) + '</div>';
  }

  // Tasks - stacked: tool on top, goal below
  html += '<div class="task-list">';
  (c.tasks || []).forEach((t, i) => {
    const toolTitle = (t.tool_name || '').replace(/_/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
    const deps = t.depends_on?.length > 0 ? '\\u2192 after ' + t.depends_on.map(d => d + 1).join(', ') : '';
    html += '<div class="task-item">';
    html += '<div class="task-header">';
    html += '<span class="task-idx">' + (i + 1) + '.</span>';
    html += '<span class="task-tool">' + esc(toolTitle) + '</span>';
    if (deps) html += '<span class="task-deps">' + deps + '</span>';
    html += '</div>';
    html += '<div class="task-goal">' + esc(t.goal) + '</div>';
    html += '</div>';
  });
  html += '</div>';

  // Gates - clickable icons toggle pass/fail, collapsible reasoning
  html += '<div class="gates">';
  const hasErrors = c.validation_errors?.length > 0;
  const structIcon = hasErrors ? '<span class="gate-fail">&#10007;</span>' : '<span class="gate-pass">&#10003;</span>';
  const structDetail = hasErrors ? c.validation_errors[0].detail : 'Valid structure';
  html += '<div class="gate-row"><span class="gate-icon">' + structIcon + '</span>';
  html += '<span class="gate-label">Structure: ' + esc(structDetail) + '</span></div>';

  ['me', 'ce', 'complexity'].forEach(key => {
    const ev = c[key];
    const names = {me: 'ME', ce: 'CE', complexity: 'CX'};
    if (ev) {
      const iconChar = ev.passed ? '&#10003;' : '&#10007;';
      const iconCls = ev.passed ? 'gate-pass' : 'gate-fail';
      const reasonId = 'reason-' + candId + '-' + key;
      const showByDefault = !ev.passed;
      html += '<div class="gate-row">';
      html += '<span class="gate-icon ' + iconCls + '" onclick="toggleEval(\\'' + key + '\\',\\'' + side + '\\',' + !ev.passed + ')">' + iconChar + '</span>';
      html += '<span class="gate-label">' + names[key] + ' (' + ev.score.toFixed(2) + ')</span>';
      if (ev.reasoning) {
        const chevron = showByDefault ? '&#9660;' : '&#9654;';
        html += '<span class="gate-chevron" onclick="toggleReasoning(\\'' + reasonId + '\\', this)">' + chevron + '</span>';
      }
      html += '</div>';
      if (ev.reasoning) {
        html += '<div class="gate-reasoning' + (showByDefault ? ' open' : '') + '" id="' + reasonId + '">' + esc(ev.reasoning) + '</div>';
      }
    } else if (!hasErrors) {
      html += '<div class="gate-row"><span class="gate-icon gate-spinner">...</span><span class="gate-label" style="color:#555">' + names[key] + '</span></div>';
    }
  });

  html += '</div></div>';
  return html;
}

function toggleCtx() {
  const p = document.getElementById('ctx-panel');
  const a = document.getElementById('ctx-arrow');
  if (p) {
    p.classList.toggle('open');
    if (a) a.innerHTML = p.classList.contains('open') ? '&#9660;' : '&#9654;';
  }
}

function toggleDesc(id, el) {
  const d = document.getElementById(id);
  if (d) {
    d.classList.toggle('open');
    el.innerHTML = d.classList.contains('open') ? '&#9660; description' : '&#9654; description';
  }
}

function toggleReasoning(id, el) {
  const d = document.getElementById(id);
  if (d) {
    d.classList.toggle('open');
    el.innerHTML = d.classList.contains('open') ? '&#9660;' : '&#9654;';
  }
}

async function toggleEval(t, side, v) {
  await fetch('/api/toggle-eval', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({eval_type:t,side:side,passed:v})});
  poll();
}

async function submitLabel(pref) {
  if (currentData?.generating) return;
  const elapsed = (Date.now() - labelStart) / 1000;
  await fetch('/api/label', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({preference:pref, label_time_s:elapsed})});
  startTimer();
  startPolling();
  poll();
}

async function goPrev() {
  await fetch('/api/prev');
  startPolling();
  poll();
}

let editMode = false;
let editCtxSnapshot = null;

function startEdit() {
  editMode = true;
  editCtxSnapshot = JSON.parse(JSON.stringify(lastData.task.agent_context || []));
  render(lastData);
}

function cancelEdit() {
  editMode = false;
  editCtxSnapshot = null;
  render(lastData);
}

async function saveEdit() {
  const newSeed = document.getElementById('edit-seed')?.value;
  const ctx = lastData.task.agent_context || [];
  const userCtx = ctx.filter(m => (m.role||'').toLowerCase() === 'user');
  const textareas = document.querySelectorAll('.edit-ctx');
  textareas.forEach(ta => {
    const idx = parseInt(ta.dataset.idx);
    if (idx < userCtx.length) userCtx[idx].content = ta.value;
  });

  const body = { raw_seed: newSeed, agent_context: ctx };
  await fetch('/api/edit-task', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  editMode = false;
  editCtxSnapshot = null;
  startPolling();
  poll();
}

let deleteArmed = false;
let deleteTimer = null;
function deleteTask() {
  const btn = document.getElementById('btn-delete');
  if (!deleteArmed) {
    deleteArmed = true;
    btn.classList.add('armed');
    btn.textContent = 'Confirm Delete';
    deleteTimer = setTimeout(() => {
      deleteArmed = false;
      btn.classList.remove('armed');
      btn.textContent = 'Delete Task';
    }, 1800);
  } else {
    clearTimeout(deleteTimer);
    deleteArmed = false;
    fetch('/api/skip-task', {method:'POST'}).then(() => {
      startTimer();
      startPolling();
      poll();
    });
  }
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (currentData?.generating) return;
  const k = e.key.toLowerCase();
  if (k === 'q') submitLabel('A');
  else if (k === 'e') submitLabel('B');
  else if (k === 'w') submitLabel('TIE');
  else if (k === 'r') submitLabel('SKIP');
  else if (k === 'p') goPrev();
});

// Initial load
startPolling();
poll();
updateStats();
</script>
</body>
</html>"""


if __name__ == '__main__':
    print('\\nGEPA Labeler')
    print(f'  Tasks: {len(state.task_files)}')
    print('  Pairs per task: 6 (C(4,2))')
    print(f'  Total pairs: {len(state.task_files) * 6}')
    print(f'  Already labeled: {state.total_label_count}')
    print(f'  Resume at: task {state.current_task_idx}, pair {state.current_pair_idx}')
    print('\\n  Open: http://localhost:8765\\n')
    uvicorn.run(app, host='0.0.0.0', port=8765, log_level='info')
