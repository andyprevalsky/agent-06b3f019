/**
 * Blueprints domain config — constants, defaults, env reads.
 */

/** Maximum blueprints to scan during similarity search */
export const SEARCH_SCAN_LIMIT = 100;

/** Maximum blueprints returned by list endpoint */
export const LIST_LIMIT = 50;

/** Minimum cosine similarity to include in search results */
export const SIMILARITY_THRESHOLD = 0.38;

/** Default number of search results to return */
export const DEFAULT_SEARCH_LIMIT = 3;

/** OpenAI embedding model used for blueprint embeddings */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/** True when blackbox-test capture mode is active (deterministic embedding fallback). */
export const BLACKBOX_CAPTURE_MODE =
  process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND === '1' || process.env.NODE_ENV === 'test';
