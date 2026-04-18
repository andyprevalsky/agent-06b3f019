"""Runtime entry point for the `gepa-judge` pipeline.

Runs ``judge_all_tasks`` to generate synthetic preference labels via an LLM
judge. Mirrors the historical ``research/gepa/run_judge.py`` script.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from collections import Counter
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agents'))

load_dotenv(ROOT / 'agents' / '.env')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


async def main() -> None:
    from research.gepa.pipelines.synthetic_pairs import judge_all_tasks

    start = time.time()
    logger.info('Starting synthetic label generation...')

    new_labels = await judge_all_tasks()

    elapsed = time.time() - start
    logger.info('Done! Generated %d new labels in %.1fs', len(new_labels), elapsed)

    prefs = Counter(label['preference'] for label in new_labels)
    logger.info('New label distribution: %s', dict(prefs))


if __name__ == '__main__':
    asyncio.run(main())
