"""Runner script: generate all remaining synthetic labels via LLM judge.

Usage:
    PYTHONPATH=agents python research/gepa/run_judge.py
"""

import asyncio
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'agents'))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / 'agents' / '.env')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


async def main():
    from research.gepa.pipelines.synthetic_pairs import judge_all_tasks

    start = time.time()
    logger.info('Starting synthetic label generation...')

    new_labels = await judge_all_tasks()

    elapsed = time.time() - start
    logger.info(f'Done! Generated {len(new_labels)} new labels in {elapsed:.1f}s')

    # Quick summary
    from collections import Counter

    prefs = Counter(l['preference'] for l in new_labels)
    logger.info(f'New label distribution: {dict(prefs)}')


if __name__ == '__main__':
    asyncio.run(main())
