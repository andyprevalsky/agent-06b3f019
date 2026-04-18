"""GEPA domain config layer — constants, defaults, data paths.

Centralises every literal or path referenced by the GEPA pipelines so that
repo/service/runtime layers stay declarative.
"""

from __future__ import annotations

from research.gepa.critic import DATA_DIR, LABELS_PATH, STATE_PATH, TASKS_DIR
from research.gepa.embeddings import EMBEDDING_CACHE_PATH
from research.gepa.embeddings import MODEL as EMBEDDING_MODEL
from research.gepa.pipelines.gepa_optimizer import (
    DEFAULT_CRITIC_MODEL_ID,
    MAX_RETRIES,
    RETRY_DELAY_S,
    STRATEGY_END,
    STRATEGY_ENDS,
    STRATEGY_START,
    STRATEGY_STARTS,
)
from research.gepa.scoring.final_scorer import ALPHA, BETA, GAMMA
from research.gepa.scoring.soft_penalties import LAMBDA
from research.gepa.validators import MAX_TASKS, MIN_TASKS

# Derived data paths (used by run_full_pipeline runtime).
GEPA_LOG_DIR = DATA_DIR / 'gepa_logs_v3'
PROGRESS_FILE = DATA_DIR / 'gepa_progress.json'
OPTIMIZATION_RESULT_PATH = DATA_DIR / 'optimization_result.json'

# Judge/full pipeline retry tuning (mirrors run_full_pipeline.py constants).
CRITIC_MODEL_ID = 'gepa_critic_312'
MAX_CRITIC_RETRIES = 3
CRITIC_RETRY_DELAY_S = 5

__all__ = [
    'ALPHA',
    'BETA',
    'CRITIC_MODEL_ID',
    'CRITIC_RETRY_DELAY_S',
    'DATA_DIR',
    'DEFAULT_CRITIC_MODEL_ID',
    'EMBEDDING_CACHE_PATH',
    'EMBEDDING_MODEL',
    'GAMMA',
    'GEPA_LOG_DIR',
    'LABELS_PATH',
    'LAMBDA',
    'MAX_CRITIC_RETRIES',
    'MAX_RETRIES',
    'MAX_TASKS',
    'MIN_TASKS',
    'OPTIMIZATION_RESULT_PATH',
    'PROGRESS_FILE',
    'RETRY_DELAY_S',
    'STATE_PATH',
    'STRATEGY_END',
    'STRATEGY_ENDS',
    'STRATEGY_START',
    'STRATEGY_STARTS',
    'TASKS_DIR',
]
