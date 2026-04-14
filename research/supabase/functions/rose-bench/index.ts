// deno-lint-ignore-file no-console no-await-in-loop -- Edge function: console is the only log channel; benchmark questions must run sequentially
import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@~2.39.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
  'Access-Control-Allow-Methods': 'OPTIONS, POST',
};

/** Allowlist of hostnames permitted for benchmark endpoint URLs. */
const ALLOWED_HOSTNAMES = new Set([
  'kzlurqihzaolhzsbkctf.supabase.co',
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
  'localhost',
]);

/** Validate that a user-provided URL is https (or localhost) and on the allowlist. */
function validateBenchmarkUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error('Only HTTPS URLs are allowed');
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(`Hostname not allowed: ${parsed.hostname}`);
  }
  return parsed.toString();
}

interface BenchmarkQuestion {
  id: string;
  question: string;
  options: string[];
  correctAnswer: string;
}

interface ModelConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  seed?: number;
  cotSteps?: number;
}

interface QuestionResult {
  questionId: string;
  modelResponse: string;
  extractedAnswer: string;
  isCorrect: boolean;
  costCents: number;
  durationMs: number;
  metadata: Record<string, unknown>;
}

interface BenchmarkResult {
  benchmarkName: string;
  totalQuestions: number;
  sampledQuestions: number;
  correctAnswers: number;
  accuracy: number;
  totalCostCents: number;
  totalDurationSeconds: number;
  results: QuestionResult[];
  isSampled: boolean;
  modelConfig: ModelConfig;
}

const BENCHMARKS: Record<string, string> = {
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

const SAMPLE_QUESTIONS: BenchmarkQuestion[] = [
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
    options: ['A) Charles Dickens', 'B) William Shakespeare', 'C) Jane Austen', 'D) Mark Twain'],
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
    options: ['A) 300,000 km/s', 'B) 150,000 km/s', 'C) 450,000 km/s', 'D) 600,000 km/s'],
    correctAnswer: 'A',
  },
];

function sampleQuestions(
  questions: BenchmarkQuestion[],
  sampleSize: number,
  seed?: number,
): BenchmarkQuestion[] {
  const shuffled = [...questions];
  let currentIndex = shuffled.length;
  let randomIndex;

  const random = seed !== undefined ? seededRandom(seed) : Math.random;

  while (currentIndex !== 0) {
    randomIndex = Math.floor(random() * currentIndex);
    currentIndex--;
    [shuffled[currentIndex], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[currentIndex],
    ];
  }

  return shuffled.slice(0, sampleSize);
}

function seededRandom(seed: number): () => number {
  let x = Math.sin(seed++) * 10000;
  return (): number => {
    x = Math.sin(x) * 10000;
    return x - Math.floor(x);
  };
}

function formatQuestion(q: BenchmarkQuestion): string {
  return `${q.question}\n\n${q.options.join('\n')}\n\nAnswer with only the letter (A, B, C, or D):`;
}

function extractAnswer(response: string): string {
  const match = response.match(/\b([A-D])\b/i);
  return match ? match[1].toUpperCase() : '';
}

async function runSingleBenchmark(
  url: string,
  headers: Record<string, string>,
  modelConfig: ModelConfig,
  benchmarkName: string,
  seed?: number,
): Promise<BenchmarkResult> {
  const maxSamples = parseInt(Deno.env.get('MAX_SAMPLES_PER_BENCH') || '100');
  const questions = sampleQuestions(
    SAMPLE_QUESTIONS,
    Math.min(maxSamples, SAMPLE_QUESTIONS.length),
    seed,
  );

  const results: QuestionResult[] = [];
  const startTime = Date.now();

  for (const question of questions) {
    const questionStart = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: [{
            role: 'user',
            content: formatQuestion(question),
          }],
          temperature: modelConfig.temperature,
          max_tokens: modelConfig.maxTokens,
          seed: modelConfig.seed,
          cot_steps: modelConfig.cotSteps,
        }),
      });

      if (!response.ok) {
        throw new Error(`Model API error: ${response.status}`);
      }

      const data = await response.json();
      const modelResponse = data.choices?.[0]?.message?.content || '';
      const extractedAnswer = extractAnswer(modelResponse);
      const isCorrect = extractedAnswer === question.correctAnswer;

      results.push({
        questionId: question.id,
        modelResponse,
        extractedAnswer,
        isCorrect,
        costCents: 0, // Cost tracked separately in logs
        durationMs: Date.now() - questionStart,
        metadata: {
          question: question.question,
          correctAnswer: question.correctAnswer,
        },
      });
    } catch (error) {
      console.error(`Error on question ${question.id}:`, error);
      results.push({
        questionId: question.id,
        modelResponse: '',
        extractedAnswer: '',
        isCorrect: false,
        costCents: 0,
        durationMs: Date.now() - questionStart,
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  const correctAnswers = results.filter((r) => r.isCorrect).length;
  const totalDurationSeconds = (Date.now() - startTime) / 1000;

  return {
    benchmarkName,
    totalQuestions: SAMPLE_QUESTIONS.length,
    sampledQuestions: questions.length,
    correctAnswers,
    accuracy: results.length > 0 ? (correctAnswers / results.length) * 100 : 0,
    totalCostCents: 0, // Cost tracked in logs
    totalDurationSeconds,
    results,
    isSampled: questions.length < SAMPLE_QUESTIONS.length,
    modelConfig,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 405,
    });
  }

  try {
    const { url, headers, modelConfig, benchmark, seed } = await req.json();

    if (!url) {
      return new Response(JSON.stringify({ error: 'Missing required field: url' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    let validatedUrl: string;
    try {
      validatedUrl = validateBenchmarkUrl(url);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: `Invalid url: ${e instanceof Error ? e.message : 'validation failed'}` }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        },
      );
    }

    if (!modelConfig || !modelConfig.model) {
      return new Response(
        JSON.stringify({ error: 'Missing required field: modelConfig with model' }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        },
      );
    }

    if (!benchmark) {
      return new Response(JSON.stringify({ error: 'Missing required field: benchmark' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    if (!BENCHMARKS[benchmark as string]) {
      return new Response(
        JSON.stringify({
          error: `Invalid benchmark type: ${benchmark}`,
          availableBenchmarks: Object.keys(BENCHMARKS),
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        },
      );
    }

    if (benchmark === 'full') {
      const allBenchmarks = Object.keys(BENCHMARKS).filter((b) => b !== 'full');
      const benchmarkResults: BenchmarkResult[] = [];
      const overallStartTime = Date.now();
      let totalCost = 0;

      for (const benchmarkType of allBenchmarks) {
        try {
          const result = await runSingleBenchmark(
            validatedUrl,
            headers || {},
            modelConfig,
            benchmarkType,
            seed,
          );
          benchmarkResults.push(result);
          totalCost += result.totalCostCents;
        } catch (error) {
          console.error(`Error running ${benchmarkType}:`, error);
        }
      }

      const totalDuration = (Date.now() - overallStartTime) / 1000;
      const totalQuestions = benchmarkResults.reduce((sum, b) => sum + b.sampledQuestions, 0);
      const totalCorrect = benchmarkResults.reduce((sum, b) => sum + b.correctAnswers, 0);
      const aggregateAccuracy = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;

      return new Response(
        JSON.stringify({
          totalDurationSeconds: totalDuration,
          totalCostCents: totalCost,
          benchmarks: benchmarkResults,
          aggregateAccuracy,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    }

    const result = await runSingleBenchmark(validatedUrl, headers || {}, modelConfig, benchmark, seed);

    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (supabaseUrl && supabaseServiceKey) {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const { error: insertError } = await supabase
          .from('BenchmarkRun')
          .insert({
            userId: 'anonymous', // TODO(#auth): Get actual user if authenticated
            benchmarkName: result.benchmarkName,
            modelConfig: modelConfig,
            results: result.results,
            aggregateScore: result.accuracy,
            totalCostCents: result.totalCostCents,
            sampledQuestions: result.sampledQuestions,
            durationSeconds: Math.round(result.totalDurationSeconds),
          });
        if (insertError) {
          console.error('Supabase insert error:', insertError.message);
        }
      }
    } catch (error) {
      console.error('Failed to log benchmark run:', error);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    console.error('Benchmark error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to run benchmark' }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    );
  }
});
