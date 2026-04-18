"""Runtime entry point for the `gepa-smoke` pipeline.

Minimal smoke test for the GEPA optimiser: trains the reward model (if
needed) and runs an auto=light optimisation across five tasks.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agents'))

load_dotenv(ROOT / 'agents' / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

SMOKE_BASE_MODEL = 'TinyLlama/TinyLlama-1.1B-Chat-v1.0'
SMOKE_MODEL_ID = 'smoke_reward_model'


def _train_smoke_reward_model():
    from research.domains.gepa.repo import prepare_reward_pairs
    from research.domains.gepa.service import train_reward_model

    logger.info('=== Step 1: Train reward model ===')
    rows = prepare_reward_pairs()
    n_pairs = len(rows['prompt'])
    logger.info('  %d training pairs available', n_pairs)
    if n_pairs < 5:
        logger.error('Not enough training pairs (%d). Need at least 5.', n_pairs)
        sys.exit(1)
    logger.info(
        '  Training on Modal GPU with %s (this may take a few minutes)...', SMOKE_BASE_MODEL
    )
    train_result = train_reward_model(rows, base_model=SMOKE_BASE_MODEL, model_id=SMOKE_MODEL_ID)
    logger.info(
        '  Training complete: loss=%s, model_id=%s',
        train_result.get('train_loss', 'N/A'),
        train_result['model_id'],
    )


def _run_smoke_optimization():
    from research.domains.gepa.config import TASKS_DIR
    from research.domains.gepa.repo import load_trainset
    from research.domains.gepa.service import (
        _make_decomposer_module,
        get_initial_strategy,
        optimize_prompt,
    )

    logger.info('=== Step 2: Strategy extraction ===')
    strategy = get_initial_strategy()
    logger.info('Extracted strategy (%d chars)', len(strategy))

    logger.info('=== Step 3: Load trainset (5 tasks) ===')
    full_trainset = load_trainset(TASKS_DIR)
    trainset = full_trainset[:5]
    for i, ex in enumerate(trainset):
        logger.info('  Task %d: %s', i, ex.goal[:80])

    logger.info('=== Step 4: Create DSPy module ===')
    module = _make_decomposer_module()
    logger.info(
        'Module: %s, instruction length: %d chars',
        type(module).__name__,
        len(module.planner.signature.instructions),
    )

    logger.info('=== Step 5: Run optimiser (auto=light, 5 tasks) ===')
    return optimize_prompt(
        auto='light',
        num_threads=2,
        trainset=trainset,
        critic_model_id=SMOKE_MODEL_ID,
    )


def _report(result) -> None:
    logger.info('\n=== RESULTS ===')
    logger.info('Optimized strategy (%d chars):', len(result.optimized_strategy))
    logger.info(result.optimized_strategy[:500])
    logger.info('Demos bootstrapped: %d', len(result.demos))

    opt_prompt = result.optimized_prompt
    assert 'OUTPUT CONTRACT' in opt_prompt, 'Missing OUTPUT CONTRACT'
    assert 'AVAILABLE TOOLS' in opt_prompt, 'Missing AVAILABLE TOOLS'
    assert 'SPAWN_SUB_AGENT TOOL' in opt_prompt, 'Missing SPAWN_SUB_AGENT'
    logger.info('Optimized prompt length: %d chars — all fixed sections present', len(opt_prompt))
    logger.info('\n=== SMOKE TEST PASSED ===')


def main() -> None:
    _train_smoke_reward_model()
    result = _run_smoke_optimization()
    _report(result)


if __name__ == '__main__':
    main()
