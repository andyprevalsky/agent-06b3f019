"""GEPA domain repo layer — data access for preference labels, clarified
tasks, and the embedding cache.

Each function takes typed args and returns typed results. The repo layer is
framework-agnostic; it performs file I/O only and never contains business
logic or network calls.
"""

from __future__ import annotations

from research.gepa.critic import prepare_reward_pairs
from research.gepa.embeddings import EmbeddingCache
from research.gepa.pipelines.gepa_optimizer import TASKS_DIR, _load_trainset

__all__ = [
    'TASKS_DIR',
    'EmbeddingCache',
    'load_trainset',
    'prepare_reward_pairs',
]


def load_trainset(tasks_dir=TASKS_DIR):
    """Load clarified tasks from ``tasks_dir`` as a list of DSPy Examples."""
    return _load_trainset(tasks_dir)
