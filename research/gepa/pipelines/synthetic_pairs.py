"""Synthetic pair generator: LLM judge picks winner from candidate pairs.

Uses few-shot examples from human preference labels, retrieved via
embedding similarity on the task seed. Position bias is mitigated
by running the judge twice with A/B swapped.

Flow:
  task → retrieve similar human labels (embedding) → for each pair:
      → judge_once(A, B) + judge_once(B, A) → debiased verdict
      → store as synthetic preference label
"""

import asyncio
import json
import logging
import uuid
from itertools import combinations
from pathlib import Path
from typing import Literal

from helpers.llm import call_llm_structured_streaming
from pydantic import BaseModel, Field

from ..critic import serialize_candidate, serialize_prompt
from ..embeddings import EmbeddingCache, embed_texts, retrieve_similar_pairs

logger = logging.getLogger(__name__)

MODEL = 'rose-labs/rose-1-ultra'
DATA_DIR = Path(__file__).parent.parent / 'data'
LABELS_PATH = DATA_DIR / 'preference_labels.json'
STATE_PATH = DATA_DIR / 'labeler_state.json'
TASKS_DIR = DATA_DIR / 'clarified_tasks'


# ---------------------------------------------------------------------------
# Pydantic response model
# ---------------------------------------------------------------------------


class JudgeVerdict(BaseModel):
    overall_winner: Literal['A', 'B', 'TIE'] = Field(
        description='Which candidate is better: A, B, or TIE if too close to call'
    )
    overall_reasoning: str = Field(
        description='2-3 concise bullet points (use • prefix) explaining the verdict'
    )
    confidence: float = Field(description='Confidence in the verdict, 0-100')


# ---------------------------------------------------------------------------
# Candidate formatting
# ---------------------------------------------------------------------------


def format_candidate_for_judge(candidate: dict, label: str = 'A') -> str:
    """Format a candidate dict (from candidates_cache) for the judge prompt."""
    return f'## Candidate {label}\n{serialize_candidate(candidate)}'


# ---------------------------------------------------------------------------
# Few-shot example formatting
# ---------------------------------------------------------------------------


def format_few_shot_example(
    label: dict,
    candidates_cache: dict[str, list],
    task_id_to_file: dict[str, str],
) -> str | None:
    """Format a single human label as a few-shot example for the judge.

    Returns None if the label's candidates can't be found in cache.
    """
    task_id = label.get('task_id', '')
    filename = task_id_to_file.get(task_id)
    if not filename or filename not in candidates_cache:
        return None

    candidates = candidates_cache[filename]
    a_idx = label.get('candidate_a_idx', 0)
    b_idx = label.get('candidate_b_idx', 1)

    if a_idx >= len(candidates) or b_idx >= len(candidates):
        return None
    cand_a = candidates[a_idx]
    cand_b = candidates[b_idx]
    if cand_a is None or cand_b is None:
        return None

    pref = label.get('preference', 'TIE')
    seed = label.get('task_seed', '')

    lines = [
        f'### Example — Goal: "{seed}"',
        format_candidate_for_judge(cand_a, 'A'),
        format_candidate_for_judge(cand_b, 'B'),
        f'**Verdict: {pref}**',
    ]
    return '\n\n'.join(lines)


# ---------------------------------------------------------------------------
# Judge prompt
# ---------------------------------------------------------------------------

JUDGE_SYSTEM_PROMPT = """You are a judge who is tasked with labeling data.

You will be given a goal and two candidate task decomposition plans (A and B).

You are to decide if A is better than B (A), they are equal (TIE), or B is better than A (B).

You should reason across these metrics:

1. All sub-tasks should be mutually exclusive — there should be no work duplicated across sub-tasks.
2. All sub-tasks should collectively be exhaustive — completion of all sub-tasks should imply completion of the task that is being decomposed.
3. Each sub-task should be strictly less complex than the task being decomposed.
4. The expected cost of each sub-task should be minimized.
5. The total time required to complete each sub-task should be minimized.
6. The expected probability of success for all sub-tasks should be maximized.

Use these expertly labeled examples for reference, as some principles might not be enumerated above:

{few_shot_section}

Now evaluate the following pair. Return your judgment as JSON."""

JUDGE_USER_PROMPT = """## Goal
{goal}

## Context
{context}

{candidate_a}

{candidate_b}

Which candidate is better? Return your verdict."""


# ---------------------------------------------------------------------------
# Core judge functions
# ---------------------------------------------------------------------------


def _flip_winner(winner: str) -> str:
    """Flip A↔B, TIE stays TIE."""
    return {'A': 'B', 'B': 'A', 'TIE': 'TIE'}.get(winner, 'TIE')


async def _judge_once(
    goal: str,
    context: str,
    candidate_a_text: str,
    candidate_b_text: str,
    few_shot_section: str,
) -> JudgeVerdict:
    """Single judge call. Returns JudgeVerdict."""
    system = JUDGE_SYSTEM_PROMPT.format(few_shot_section=few_shot_section)
    user = JUDGE_USER_PROMPT.format(
        goal=goal,
        context=context,
        candidate_a=candidate_a_text,
        candidate_b=candidate_b_text,
    )

    messages = [
        {'role': 'system', 'content': system},
        {'role': 'user', 'content': user},
    ]

    async def noop(text: str, count: int):
        pass

    last_err = None
    for attempt in range(3):
        try:
            result, _usage, _ = await call_llm_structured_streaming(
                messages=messages,
                model=MODEL,
                temperature=0.0,
                max_tokens=4096,
                response_model=JudgeVerdict,
                on_chunk=noop,
            )
            return result
        except Exception as e:
            last_err = e
            logger.warning(f'Judge attempt {attempt + 1}/3 failed: {e}')
            if attempt < 2:
                await asyncio.sleep(2)

    raise RuntimeError(f'Judge failed after 3 attempts: {last_err}')


async def judge_preference(
    goal: str,
    candidate_a: dict,
    candidate_b: dict,
    agent_context: list[dict] | None = None,
    few_shot_examples: list[str] | None = None,
) -> JudgeVerdict:
    """Debiased judge: runs twice with A/B swapped, returns consensus or TIE.

    Args:
        goal: The task seed / user goal.
        candidate_a: Candidate dict (from candidates_cache format).
        candidate_b: Candidate dict (from candidates_cache format).
        agent_context: Optional conversation context.
        few_shot_examples: List of formatted few-shot example strings.

    Returns:
        JudgeVerdict with debiased winner and averaged confidence.
    """
    context = serialize_prompt(goal, agent_context or [])
    a_text = format_candidate_for_judge(candidate_a, 'A')
    b_text = format_candidate_for_judge(candidate_b, 'B')

    # Build few-shot section
    if few_shot_examples:
        few_shot_section = (
            'Here are examples of previous judgments to calibrate your evaluation:\n\n'
            + '\n\n---\n\n'.join(few_shot_examples)
            + '\n\n---\n'
        )
    else:
        few_shot_section = ''

    # Run both directions in parallel
    j_ab, j_ba = await asyncio.gather(
        _judge_once(goal, context, a_text, b_text, few_shot_section),
        _judge_once(goal, context, b_text, a_text, few_shot_section),
    )

    # Flip j_ba's winner back to original orientation
    ba_flipped = _flip_winner(j_ba.overall_winner)

    avg_confidence = (j_ab.confidence + j_ba.confidence) / 2

    if j_ab.overall_winner == ba_flipped:
        # Both agree
        return JudgeVerdict(
            overall_winner=j_ab.overall_winner,
            overall_reasoning=j_ab.overall_reasoning,
            confidence=avg_confidence,
        )
    else:
        # Disagree → TIE with low confidence
        return JudgeVerdict(
            overall_winner='TIE',
            overall_reasoning=f'Position bias detected: AB→{j_ab.overall_winner}, BA→{j_ba.overall_winner}',
            confidence=min(avg_confidence, 30.0),
        )


# ---------------------------------------------------------------------------
# Batch functions
# ---------------------------------------------------------------------------


def _build_task_id_to_file(tasks_dir: Path) -> dict[str, str]:
    """Build task_id → filename mapping."""
    mapping = {}
    for path in tasks_dir.glob('*.json'):
        with open(path) as f:
            task = json.load(f)
        mapping[task['id']] = path.name
    return mapping


def _get_existing_label_keys(labels: list[dict]) -> set[str]:
    """Build set of (task_id, a_idx, b_idx) keys from existing labels."""
    return {f'{l["task_id"]}_{l["candidate_a_idx"]}_{l["candidate_b_idx"]}' for l in labels}


async def judge_all_pairs(
    task_seed: str,
    agent_context: list[dict],
    candidates: list[dict],
    few_shot_examples: list[str] | None = None,
    semaphore: asyncio.Semaphore | None = None,
) -> list[dict]:
    """Judge all C(K,2) pairs for one task, concurrently.

    Returns label dicts in the same schema as preference_labels.json,
    with source='llm_labeled'.
    """
    non_null = [(i, c) for i, c in enumerate(candidates) if c is not None]
    pairs = list(combinations(non_null, 2))

    async def _judge_one(a_idx, cand_a, b_idx, cand_b):
        if semaphore:
            async with semaphore:
                return await _do_judge(a_idx, cand_a, b_idx, cand_b)
        return await _do_judge(a_idx, cand_a, b_idx, cand_b)

    async def _do_judge(a_idx, cand_a, b_idx, cand_b):
        try:
            verdict = await judge_preference(
                goal=task_seed,
                candidate_a=cand_a,
                candidate_b=cand_b,
                agent_context=agent_context,
                few_shot_examples=few_shot_examples,
            )
            return {
                'pair_id': str(uuid.uuid4()),
                'task_id': '',  # Filled by caller
                'task_seed': task_seed,
                'candidate_a_idx': a_idx,
                'candidate_b_idx': b_idx,
                'preference': verdict.overall_winner,
                'label_time_s': 0,
                'timestamp': 0,
                'source': 'llm_labeled',
                'confidence': verdict.confidence,
                'reasoning': verdict.overall_reasoning,
            }
        except Exception as e:
            logger.error(f'Failed to judge pair ({a_idx}, {b_idx}): {e}')
            return None

    coros = [_judge_one(a_idx, ca, b_idx, cb) for (a_idx, ca), (b_idx, cb) in pairs]
    raw = await asyncio.gather(*coros)
    return [r for r in raw if r is not None]


async def judge_all_tasks(
    tasks_dir: str | Path = TASKS_DIR,
    state_path: str | Path = STATE_PATH,
    labels_path: str | Path = LABELS_PATH,
) -> list[dict]:
    """Full batch: embed tasks, retrieve few-shot examples, judge all pairs.

    Writes new labels directly into preference_labels.json with
    source='llm_labeled'. Skips pairs that already have labels (human or LLM).

    Returns list of newly created labels.
    """
    import time

    tasks_dir = Path(tasks_dir)
    state_path = Path(state_path)
    labels_path = Path(labels_path)

    # Load state
    with open(state_path) as f:
        state = json.load(f)
    candidates_cache = state.get('candidates_cache', {})

    # Load all existing labels (human + any previous LLM labels)
    with open(labels_path) as f:
        all_labels = json.load(f)

    # Human trainable labels for few-shot retrieval (exclude LLM-labeled)
    human_trainable = [
        l
        for l in all_labels
        if l.get('preference') in ('A', 'B') and l.get('source') != 'llm_labeled'
    ]
    existing_keys = _get_existing_label_keys(all_labels)

    # Load task contexts
    task_contexts: dict[str, dict] = {}
    for path in tasks_dir.glob('*.json'):
        with open(path) as f:
            task = json.load(f)
        task_contexts[path.name] = task

    task_id_to_file = {t['id']: fn for fn, t in task_contexts.items()}

    # Embed all task seeds for few-shot retrieval
    all_seeds = list({t.get('raw_seed', '') for t in task_contexts.values()})
    all_seeds += [l.get('task_seed', '') for l in human_trainable]
    all_seeds = list(set(s for s in all_seeds if s))

    cache = EmbeddingCache()
    embeddings = embed_texts(all_seeds, cache=cache)
    task_embeddings = dict(zip(all_seeds, embeddings, strict=False))

    new_labels = []
    labels_lock = asyncio.Lock()

    # Global semaphore: limits concurrent judge calls (each pair = 2 LLM calls)
    semaphore = asyncio.Semaphore(5)

    # Build work items for all tasks that need judging
    work_items = []
    for filename, candidates in candidates_cache.items():
        task_data = task_contexts.get(filename)
        if task_data is None:
            continue

        task_id = task_data['id']
        task_seed = task_data.get('raw_seed', '')
        agent_context = task_data.get('agent_context', [])

        # Check which pairs need labels
        non_null = [(i, c) for i, c in enumerate(candidates) if c is not None]
        pairs = list(combinations(non_null, 2))
        unlabeled = []
        for (a_idx, _), (b_idx, _) in pairs:
            key = f'{task_id}_{a_idx}_{b_idx}'
            if key not in existing_keys:
                unlabeled.append((a_idx, b_idx))

        if not unlabeled:
            continue

        # Retrieve few-shot examples from human labels
        similar = retrieve_similar_pairs(task_seed, human_trainable, task_embeddings, n=10)
        few_shot_strs = []
        for label in similar:
            example = format_few_shot_example(label, candidates_cache, task_id_to_file)
            if example:
                few_shot_strs.append(example)

        work_items.append(
            (filename, task_id, task_seed, agent_context, candidates, few_shot_strs, len(unlabeled))
        )

    logger.info(f'{len(work_items)} tasks need judging, processing concurrently (semaphore=5)')

    async def _process_task(
        filename, task_id, task_seed, agent_context, candidates, few_shot_strs, n_unlabeled
    ):
        logger.info(f'Judging {n_unlabeled} pairs for {filename} ({len(few_shot_strs)} few-shot)')

        task_labels = await judge_all_pairs(
            task_seed=task_seed,
            agent_context=agent_context,
            candidates=candidates,
            few_shot_examples=few_shot_strs,
            semaphore=semaphore,
        )

        added = 0
        async with labels_lock:
            for label in task_labels:
                label['task_id'] = task_id
                label['timestamp'] = time.time()
                key = f'{task_id}_{label["candidate_a_idx"]}_{label["candidate_b_idx"]}'
                if key not in existing_keys:
                    existing_keys.add(key)
                    all_labels.append(label)
                    new_labels.append(label)
                    added += 1

            # Save incrementally
            with open(labels_path, 'w') as f:
                json.dump(all_labels, f, indent=2)

        logger.info(
            f'Done {filename}: +{added} labels (total LLM: {len([l for l in all_labels if l.get("source") == "llm_labeled"])})'
        )

    await asyncio.gather(*[_process_task(*item) for item in work_items])

    logger.info(f'Added {len(new_labels)} LLM-labeled pairs to preference_labels.json')
    return new_labels
