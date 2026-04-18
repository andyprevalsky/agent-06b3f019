/**
 * Rose-Bench Config
 *
 * Constants, defaults, and env reads for the benchmark runner.
 * Config layer: may import only from own types.
 */

import type { BenchmarkQuestion } from './types.ts';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
  'Access-Control-Allow-Methods': 'OPTIONS, POST',
};

/** Allowlist of hostnames permitted for benchmark endpoint URLs. */
export const ALLOWED_HOSTNAMES = new Set<string>([
  'kzlurqihzaolhzsbkctf.supabase.co',
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'localhost',
]);

/** Registry of supported benchmark identifiers → display name. */
export const BENCHMARKS: Record<string, string> = {
  'mmlu-pro': 'MMLU-Pro',
  'terminal-bench': 'Terminal-Bench',
  'gpqa-diamond': 'GPQA-Diamond',
  'aime-2025': 'AIME-2025',
  'hle': 'HLE',
  'ifbench': 'IFBench',
  'scicode': 'SciCode',
  'livecodebench': 'LiveCodeBench',
  'swe-bench': 'SWE-Bench',
  'tau2-bench': '\u03C4\u00B2-Bench',
  'aa-lcr': 'AA-LCR',
  'full': 'Full Suite',
};

export const FULL_BENCHMARK_KEY = 'full';

/** Canned sample questions used until real benchmark data is wired in. */
export const SAMPLE_QUESTIONS: BenchmarkQuestion[] = [
  {
    id: 'q1',
    question: 'What is the capital of France?',
    options: ['A) London', 'B) Berlin', 'C) Paris', 'D) Madrid'],
    correctAnswer: 'C',
  },
  {
    id: 'q2',
    question: 'What is 2 + 2?',
    options: ['A) 3', 'B) 4', 'C) 5', 'D) 6'],
    correctAnswer: 'B',
  },
  {
    id: 'q3',
    question: "Who wrote 'Romeo and Juliet'?",
    options: [
      'A) Charles Dickens',
      'B) William Shakespeare',
      'C) Jane Austen',
      'D) Mark Twain',
    ],
    correctAnswer: 'B',
  },
  {
    id: 'q4',
    question: 'What is the largest planet in our solar system?',
    options: ['A) Earth', 'B) Mars', 'C) Jupiter', 'D) Saturn'],
    correctAnswer: 'C',
  },
  {
    id: 'q5',
    question: 'What is the speed of light in vacuum (approximately)?',
    options: [
      'A) 300,000 km/s',
      'B) 150,000 km/s',
      'C) 450,000 km/s',
      'D) 600,000 km/s',
    ],
    correctAnswer: 'A',
  },
];

export const DEFAULT_MAX_SAMPLES_PER_BENCH = 100;

/** Read the max-samples override from env, falling back to the default. */
export function getMaxSamplesPerBench(): number {
  const raw = Deno.env.get('MAX_SAMPLES_PER_BENCH');
  if (!raw) return DEFAULT_MAX_SAMPLES_PER_BENCH;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SAMPLES_PER_BENCH;
}

export function getSupabaseUrl(): string | undefined {
  return Deno.env.get('SUPABASE_URL');
}

export function getSupabaseServiceRoleKey(): string | undefined {
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}
