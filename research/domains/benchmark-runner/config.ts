/**
 * Config layer for the benchmark-runner domain.
 *
 * Layer boundaries (import rules):
 *   - May import only from own types.
 *   - Holds magic numbers, defaults, and env reads.
 */

/** Default sample size when dataset exceeds it and no override is supplied. */
export const DEFAULT_SAMPLE_SIZE = 100;

/** Default seed for deterministic sampling. */
export const DEFAULT_SEED = 42;

/** Default number of chain-of-thought steps for model calls. */
export const DEFAULT_COT_STEPS = 1;

/** Default temperature for model calls. */
export const DEFAULT_TEMPERATURE = 0.7;

/** Default maximum completion tokens for model calls. */
export const DEFAULT_MAX_TOKENS = 2000;

/** Approximate cost per prompt token in US dollars (OpenAI-ish pricing). */
export const PROMPT_TOKEN_COST_USD = 0.00005;

/** Approximate cost per completion token in US dollars. */
export const COMPLETION_TOKEN_COST_USD = 0.00015;

/** Rose model identifier sent in benchmark requests. */
export const ROSE_MODEL_ID = 'rose-labs/rose';

/** Default URL for the model completions endpoint. */
export const DEFAULT_MODEL_URL = 'http://localhost:3001/v1/chat/completions';

/** Cosine similarity threshold above which two messages count as a repetition. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.99;

/** Minimum number of consecutive similar messages required to flag a loop. */
export const DEFAULT_MIN_REPETITIONS = 3;

/** Default window size for the stateful RepetitionChecker. */
export const DEFAULT_REPETITION_WINDOW = 5;

/** Terminal-Bench truncation length for extracted answers. */
export const TERMINAL_BENCH_EXTRACT_LENGTH = 500;

/** Terminal-Bench keyword coverage threshold (50%) for a passing answer. */
export const TERMINAL_BENCH_KEYWORD_PASS_RATIO = 0.5;

/** Terminal-Bench RepetitionChecker tuning. */
export const TERMINAL_BENCH_REPETITION_WINDOW = 5;
export const TERMINAL_BENCH_REPETITION_THRESHOLD = 0.99;
export const TERMINAL_BENCH_MIN_REPETITIONS = 3;

/** Reads the optional MAX_SAMPLES_PER_BENCH env var as an integer. */
export function readMaxSamplesEnv(): number | undefined {
  const raw = Deno.env.get('MAX_SAMPLES_PER_BENCH');
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads MODEL_URL env var or returns the default. */
export function readModelUrlEnv(): string {
  return Deno.env.get('MODEL_URL') ?? DEFAULT_MODEL_URL;
}

/** Reads API_KEY env var or returns an empty string. */
export function readApiKeyEnv(): string {
  return Deno.env.get('API_KEY') ?? '';
}

/** Canonical env getter for the benchmark-runner domain. */
export function getEnv(key: string): string | undefined {
  return Deno.env.get(key);
}
