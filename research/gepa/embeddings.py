"""Embedding utilities for GEPA — embed task seeds, cache vectors, retrieve similar pairs.

Uses OpenAI text-embedding-3-small for cheap, fast embeddings.
"""

import hashlib
import json
import logging
import math
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv('agents/.env')

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent / 'data'
EMBEDDING_CACHE_PATH = DATA_DIR / 'embedding_cache.json'
MODEL = 'text-embedding-3-small'


def _text_hash(text: str) -> str:
    """Deterministic hash for cache key."""
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()[:16]


class EmbeddingCache:
    """Disk-backed embedding cache. Key: text hash → embedding vector."""

    def __init__(self, cache_path: str | Path = EMBEDDING_CACHE_PATH):
        self.cache_path = Path(cache_path)
        self._cache: dict[str, list[float]] = {}
        self._load()

    def _load(self):
        if self.cache_path.exists():
            with open(self.cache_path) as f:
                self._cache = json.load(f)
            logger.info(f'Loaded {len(self._cache)} cached embeddings')

    def save(self):
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.cache_path, 'w') as f:
            json.dump(self._cache, f)

    def get(self, text: str) -> list[float] | None:
        return self._cache.get(_text_hash(text))

    def put(self, text: str, embedding: list[float]):
        self._cache[_text_hash(text)] = embedding

    def has(self, text: str) -> bool:
        return _text_hash(text) in self._cache


def embed_texts(
    texts: list[str],
    cache: EmbeddingCache | None = None,
) -> list[list[float]]:
    """Embed texts via OpenAI, using cache for previously seen texts.

    Returns list of embedding vectors in same order as input texts.
    """
    if cache is None:
        cache = EmbeddingCache()

    # Split into cached and uncached
    results: list[list[float] | None] = [None] * len(texts)
    uncached_indices = []

    for i, text in enumerate(texts):
        cached = cache.get(text)
        if cached is not None:
            results[i] = cached
        else:
            uncached_indices.append(i)

    if uncached_indices:
        uncached_texts = [texts[i] for i in uncached_indices]
        logger.info(f'Embedding {len(uncached_texts)} texts ({len(texts) - len(uncached_texts)} cached)')

        client = OpenAI()
        # Batch in chunks of 2048 (OpenAI limit)
        for batch_start in range(0, len(uncached_texts), 2048):
            batch = uncached_texts[batch_start:batch_start + 2048]
            response = client.embeddings.create(model=MODEL, input=batch)
            for j, item in enumerate(response.data):
                idx = uncached_indices[batch_start + j]
                results[idx] = item.embedding
                cache.put(texts[idx], item.embedding)

        cache.save()
    else:
        logger.info(f'All {len(texts)} texts found in cache')

    return results


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two vectors."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def retrieve_similar_pairs(
    query_seed: str,
    human_labels: list[dict],
    task_embeddings: dict[str, list[float]],
    n: int = 30,
) -> list[dict]:
    """Find n most similar human-labeled pairs by task seed embedding similarity.

    For each human label, looks up the embedding of its task_seed in
    task_embeddings, computes similarity to query_seed's embedding,
    and returns the top n labels sorted by similarity.

    Pulls across different tasks (not just from same task).

    Args:
        query_seed: The task seed to find similar examples for.
        human_labels: List of label dicts (from preference_labels.json).
        task_embeddings: Mapping of task_seed → embedding vector.
        n: Number of similar pairs to return.

    Returns:
        List of label dicts, sorted by similarity (most similar first).
    """
    query_emb = task_embeddings.get(query_seed)
    if query_emb is None:
        logger.warning(f'No embedding for query seed: {query_seed[:60]}')
        return human_labels[:n]

    scored = []
    for label in human_labels:
        label_seed = label.get('task_seed', '')
        label_emb = task_embeddings.get(label_seed)
        if label_emb is None:
            continue
        sim = cosine_similarity(query_emb, label_emb)
        scored.append((sim, label))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [label for _sim, label in scored[:n]]
