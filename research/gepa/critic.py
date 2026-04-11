"""Bradley-Terry reward model (critic) for GEPA.

Trains a reward model from human pairwise preference labels using trl's
RewardTrainer with LoRA + 4-bit quantization. The model learns to assign
scalar scores to (task context + candidate decomposition) pairs.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent / 'data'
TASKS_DIR = DATA_DIR / 'clarified_tasks'
LABELS_PATH = DATA_DIR / 'preference_labels.json'
STATE_PATH = DATA_DIR / 'labeler_state.json'


# ---------------------------------------------------------------------------
# A. Serialization
# ---------------------------------------------------------------------------


def serialize_prompt(task_seed: str, agent_context: list[dict]) -> str:
    """Format task context as the 'prompt' for the reward model.

    Goal: {seed}
    [USER]: ...
    [ASSISTANT]: ...
    """
    lines = [f'Goal: {task_seed}']
    for msg in agent_context:
        role = msg.get('role', 'unknown').upper()
        content = msg.get('content', '')
        lines.append(f'[{role}]: {content}')
    return '\n'.join(lines)


def serialize_candidate(candidate: dict) -> str:
    """Format a candidate decomposition as text.

    Title: ...
    Content: ...
    Tasks:
      0. [web_search] Research X (depends: [])
      1. [spawn_sub_agent] Do Y (depends: [0])
    Evaluations:
      ME: pass (0.95) - reasoning...
      CE: fail (0.45) - reasoning...
      CX: pass (0.95) - reasoning...
    """
    lines = []
    lines.append(f'Title: {candidate.get("title", "")}')
    lines.append(f'Content: {candidate.get("content", "")}')

    tasks = candidate.get('tasks', [])
    if tasks:
        lines.append('Tasks:')
        for i, task in enumerate(tasks):
            goal = task.get('goal', '')
            tool = task.get('tool_name', '')
            deps = task.get('depends_on', [])
            lines.append(f'  {i}. [{tool}] {goal} (depends: {deps})')

    eval_lines = []
    for key, label in [('me', 'ME'), ('ce', 'CE'), ('complexity', 'CX')]:
        ev = candidate.get(key)
        if ev is not None:
            status = 'pass' if ev.get('passed') else 'fail'
            score = ev.get('score', 0.0)
            reasoning = ev.get('reasoning', '')
            eval_lines.append(f'  {label}: {status} ({score:.2f}) - {reasoning}')
    if eval_lines:
        lines.append('Evaluations:')
        lines.extend(eval_lines)

    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# B. Data loading
# ---------------------------------------------------------------------------


def _build_task_id_to_filename(tasks_dir: Path) -> dict[str, str]:
    """Load all clarified task JSONs and build task_id → filename map."""
    mapping = {}
    for path in tasks_dir.glob('*.json'):
        with open(path) as f:
            task = json.load(f)
        mapping[task['id']] = path.name
    return mapping


def prepare_reward_pairs(
    labels_path: str | Path = LABELS_PATH,
    state_path: str | Path = STATE_PATH,
    tasks_dir: str | Path = TASKS_DIR,
    min_confidence: float = 0,
) -> dict[str, list]:
    """Prepare reward training pairs as plain Python dicts.

    Returns dict with columns:
      - prompt: [{"role": "user", "content": serialize_prompt(...)}]
      - chosen: [{"role": "assistant", "content": serialize_candidate(winner)}]
      - rejected: [{"role": "assistant", "content": serialize_candidate(loser)}]

    Reads from preference_labels.json which contains both human and LLM-labeled
    pairs (distinguished by source field). Skips SKIP/SKIP_TASK/TIE labels.
    LLM-labeled pairs below min_confidence are filtered out.
    """
    labels_path = Path(labels_path)
    state_path = Path(state_path)
    tasks_dir = Path(tasks_dir)

    with open(labels_path) as f:
        labels = json.load(f)

    # Filter LLM-labeled pairs by confidence
    if min_confidence > 0:
        before = len(labels)
        labels = [
            l
            for l in labels
            if l.get('source') != 'llm_labeled' or l.get('confidence', 0) >= min_confidence
        ]
        logger.info(
            f'Confidence filter: {before} → {len(labels)} labels (min_confidence={min_confidence})'
        )

    with open(state_path) as f:
        state = json.load(f)

    candidates_cache = state.get('candidates_cache', {})
    task_id_to_filename = _build_task_id_to_filename(tasks_dir)

    # Load agent_context from each task file (for prompt serialization)
    task_contexts: dict[str, dict] = {}
    for path in tasks_dir.glob('*.json'):
        with open(path) as f:
            task = json.load(f)
        task_contexts[path.name] = {
            'raw_seed': task['raw_seed'],
            'agent_context': task['agent_context'],
        }

    rows = {'prompt': [], 'chosen': [], 'rejected': []}
    skipped_preference = 0
    skipped_no_candidates = 0
    total = len(labels)

    for label in labels:
        pref = label['preference']
        if pref in ('SKIP', 'SKIP_TASK', 'TIE'):
            skipped_preference += 1
            continue

        task_id = label['task_id']
        filename = task_id_to_filename.get(task_id)
        if filename is None or filename not in candidates_cache:
            skipped_no_candidates += 1
            continue

        candidates = candidates_cache[filename]
        a_idx = label['candidate_a_idx']
        b_idx = label['candidate_b_idx']

        if a_idx >= len(candidates) or b_idx >= len(candidates):
            skipped_no_candidates += 1
            continue

        cand_a = candidates[a_idx]
        cand_b = candidates[b_idx]
        if cand_a is None or cand_b is None:
            skipped_no_candidates += 1
            continue

        if pref == 'A':
            chosen, rejected = cand_a, cand_b
        else:  # pref == 'B'
            chosen, rejected = cand_b, cand_a

        ctx = task_contexts.get(filename, {})
        prompt_text = serialize_prompt(
            ctx.get('raw_seed', label.get('task_seed', '')),
            ctx.get('agent_context', []),
        )

        rows['prompt'].append([{'role': 'user', 'content': prompt_text}])
        rows['chosen'].append([{'role': 'assistant', 'content': serialize_candidate(chosen)}])
        rows['rejected'].append([{'role': 'assistant', 'content': serialize_candidate(rejected)}])

    usable = len(rows['prompt'])
    logger.info(
        f'Dataset built: {total} total labels, {usable} usable, '
        f'{skipped_preference} skipped (TIE/SKIP), '
        f'{skipped_no_candidates} skipped (no candidates)'
    )

    return rows


# ---------------------------------------------------------------------------
# C. Training (via Modal GPU)
# ---------------------------------------------------------------------------


def train_reward_model(
    rows: dict[str, list],
    base_model: str = 'google/gemma-2-9b-it',
    model_id: str = 'reward_model',
    **kwargs,
) -> dict:
    """Train reward model on Modal GPU.

    Args:
        rows: output of prepare_reward_pairs() — dict with prompt/chosen/rejected.
        base_model: HuggingFace model ID.
        model_id: name for saved model on Modal volume.
        **kwargs: forwarded to modal_critic.train (lora_r, learning_rate, etc.)

    Returns:
        dict with 'model_id', 'num_examples', 'train_loss', 'metrics'.
    """
    import modal

    train_fn = modal.Function.from_name('gepa-critic', 'train')
    return train_fn.remote(rows, base_model=base_model, model_id=model_id, **kwargs)


# ---------------------------------------------------------------------------
# D. Inference (via Modal GPU)
# ---------------------------------------------------------------------------


def score_candidates(
    candidates: list[dict],
    task_seed: str,
    agent_context: list[dict],
    model_id: str = 'reward_model',
) -> list[float]:
    """Score candidates via Modal GPU. Returns list of scalar critic_scores.

    Serializes locally, sends pre-serialized conversations to Modal for inference.
    """
    import modal

    scorer_cls = modal.Cls.from_name('gepa-critic', 'Scorer')
    scorer = scorer_cls()

    prompt_text = serialize_prompt(task_seed, agent_context)
    conversations = []
    for cand in candidates:
        conversations.append(
            [
                {'role': 'user', 'content': prompt_text},
                {'role': 'assistant', 'content': serialize_candidate(cand)},
            ]
        )

    return scorer.score.remote(conversations)
