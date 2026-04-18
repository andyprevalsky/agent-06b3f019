"""Runtime entry point for the `gepa` pipeline.

Delegates to ``research.gepa.pipelines.gepa_optimizer.optimize_prompt`` via the
service layer.
"""

from __future__ import annotations

import logging
import sys

from research.domains.gepa.service import optimize_prompt

logger = logging.getLogger(__name__)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    logger.info('GEPA Task Decomposer')
    logger.info('=' * 40)

    if '--test-mode' in sys.argv:
        logger.info('Running in test mode (light optimiser)...')
        result = optimize_prompt(auto='light', num_threads=2)
        logger.info('Initial score: %s', result.initial_score)
        logger.info('Final score:   %s', result.final_score)
        logger.info('Trials:        %s', result.num_trials)
        logger.info('Test mode complete.')
        return

    logger.info('Use --test-mode for a quick check.')


if __name__ == '__main__':
    main()
