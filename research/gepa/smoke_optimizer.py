"""Minimal smoke test for the GEPA optimizer end-to-end.

Trains the reward model (if needed), then runs MIPROv2 with 5 tasks.

Usage:
    PYTHONPATH=agents python research/gepa/smoke_optimizer.py
"""

import logging
import sys
from pathlib import Path

# Ensure project root + agents are on path
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agents'))

from dotenv import load_dotenv
load_dotenv(ROOT / 'agents' / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

from research.gepa.critic import prepare_reward_pairs, train_reward_model
from research.gepa.pipelines.gepa_optimizer import (
    get_initial_strategy,
    _load_trainset,
    _make_decomposer_module,
    optimize_prompt,
    TASKS_DIR,
)


def main():
    # 1. Train the reward model first
    logger.info('=== Step 1: Train reward model ===')
    rows = prepare_reward_pairs()
    n_pairs = len(rows['prompt'])
    logger.info(f'  {n_pairs} training pairs available')

    if n_pairs < 5:
        logger.error(f'Not enough training pairs ({n_pairs}). Need at least 5.')
        sys.exit(1)

    # Use a small non-gated model for smoke testing (Gemma requires HF gated access).
    # Switch to 'google/gemma-2-9b-it' for production once HF access is granted.
    SMOKE_BASE_MODEL = 'TinyLlama/TinyLlama-1.1B-Chat-v1.0'
    SMOKE_MODEL_ID = 'smoke_reward_model'

    logger.info(f'  Training on Modal GPU with {SMOKE_BASE_MODEL} (this may take a few minutes)...')
    train_result = train_reward_model(rows, base_model=SMOKE_BASE_MODEL, model_id=SMOKE_MODEL_ID)
    logger.info(f'  Training complete: loss={train_result.get("train_loss", "N/A")}, '
                f'model_id={train_result["model_id"]}')

    # 2. Verify strategy extraction
    logger.info('=== Step 2: Strategy extraction ===')
    strategy = get_initial_strategy()
    logger.info(f'Extracted strategy ({len(strategy)} chars)')

    # 3. Load full trainset then slice to 5 for smoke test
    logger.info('=== Step 3: Load trainset (5 tasks) ===')
    full_trainset = _load_trainset(TASKS_DIR)
    trainset = full_trainset[:5]
    for i, ex in enumerate(trainset):
        logger.info(f'  Task {i}: {ex.goal[:80]}')

    # 4. Verify module creation
    logger.info('=== Step 4: Create DSPy module ===')
    module = _make_decomposer_module()
    logger.info(f'Module: {type(module).__name__}, instruction length: '
                f'{len(module.planner.signature.instructions)} chars')

    # 5. Run MIPROv2 with minimal settings and the small trainset
    logger.info('=== Step 5: Run MIPROv2 (auto=light, 5 tasks) ===')
    result = optimize_prompt(
        auto='light',
        num_threads=2,
        trainset=trainset,
        critic_model_id=SMOKE_MODEL_ID,
    )

    # 6. Report results
    logger.info('\n=== RESULTS ===')
    logger.info(f'Optimized strategy ({len(result.optimized_strategy)} chars):')
    logger.info(result.optimized_strategy[:500])
    logger.info(f'Demos bootstrapped: {len(result.demos)}')

    # 7. Validate composed prompt
    opt_prompt = result.optimized_prompt
    assert 'OUTPUT CONTRACT' in opt_prompt, 'Missing OUTPUT CONTRACT'
    assert 'AVAILABLE TOOLS' in opt_prompt, 'Missing AVAILABLE TOOLS'
    assert 'SPAWN_SUB_AGENT TOOL' in opt_prompt, 'Missing SPAWN_SUB_AGENT'
    logger.info(f'Optimized prompt length: {len(opt_prompt)} chars — all fixed sections present')

    logger.info('\n=== SMOKE TEST PASSED ===')


if __name__ == '__main__':
    main()
