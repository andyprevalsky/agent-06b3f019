"""Main entry point for GEPA task decomposer."""

import asyncio
import json
import sys
from pathlib import Path

from .pipelines.gepa_optimizer import optimize_prompt


async def main():
    print('GEPA Task Decomposer')
    print('=' * 40)

    if '--test-mode' in sys.argv:
        print('Running in test mode...')
        result = await optimize_prompt(
            initial_prompt='You are a task decomposer.',
            max_generations=1,
            eval_batch_size=2,
        )
        print(f'Initial score: {result.initial_score}')
        print(f'Final score:   {result.final_score}')
        print(f'Generations:   {result.generations_run}')
        print('Test mode complete.')
        return

    print('Use --test-mode for a quick check.')


if __name__ == '__main__':
    asyncio.run(main())
