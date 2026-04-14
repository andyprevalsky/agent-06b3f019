"""Main entry point for GEPA task decomposer."""

import asyncio
import logging
import sys

from .pipelines.gepa_optimizer import optimize_prompt

logger = logging.getLogger(__name__)


async def main():
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    logger.info('GEPA Task Decomposer')
    logger.info('=' * 40)

    if '--test-mode' in sys.argv:
        logger.info('Running in test mode...')
        result = await optimize_prompt(
            initial_prompt='You are a task decomposer.',
            max_generations=1,
            eval_batch_size=2,
        )
        logger.info('Initial score: %s', result.initial_score)
        logger.info('Final score:   %s', result.final_score)
        logger.info('Generations:   %s', result.generations_run)
        logger.info('Test mode complete.')
        return

    logger.info('Use --test-mode for a quick check.')


if __name__ == '__main__':
    asyncio.run(main())
