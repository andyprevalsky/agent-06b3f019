// deno-lint-ignore-file no-console no-await-in-loop -- CLI benchmark runner; sequential execution is intentional (rate limits) and console output is the primary channel
/**
 * Service layer — base harness orchestration.
 *
 * Layer boundaries (import rules):
 *   - May import from own types, own config, own repo.
 *   - Abstract base class encapsulates dataset sampling, model calls, and
 *     aggregation logic shared by every concrete harness.
 */

import type {
  BenchmarkConfig,
  BenchmarkQuestion,
  BenchmarkResult,
  BenchmarkSummary,
  IBenchmarkHarness,
  ModelCallResult,
} from './types.ts';
import {
  DEFAULT_COT_STEPS,
  DEFAULT_SAMPLE_SIZE,
  DEFAULT_SEED,
  readMaxSamplesEnv,
} from './config.ts';
import { callModel, type ModelCallParams } from './repo.ts';

/**
 * Dependency-injectable model call function.
 * Defaults to the real HTTP-backed `callModel` in the repo layer; tests pass a
 * stub so no network is touched.
 */
export type CallModelFn = (params: ModelCallParams) => Promise<ModelCallResult>;

// Simple seeded random number generator
function seededRandom(seed: number): () => number {
  let state = seed;
  return function (): number {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Sample N questions deterministically using a seeded Fisher-Yates shuffle.
 * Exported for testability; exposed to subclasses via the protected wrapper.
 */
export function sampleQuestionsDeterministic(
  questions: BenchmarkQuestion[],
  n: number,
  seed: number,
): BenchmarkQuestion[] {
  if (questions.length <= n) {
    return questions;
  }

  const rng = seededRandom(seed);
  const shuffled = [...questions];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, n);
}

/** Abstract base class for concrete benchmark harnesses. */
export abstract class BaseBenchmarkHarness implements IBenchmarkHarness {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly questionCount: number;
  abstract readonly defaultRepeats: number;

  /** Injected model-call function; defaults to the HTTP-backed repo impl. */
  protected readonly callModelFn: CallModelFn;

  constructor(callModelFn: CallModelFn = callModel) {
    this.callModelFn = callModelFn;
  }

  abstract loadDataset(): Promise<BenchmarkQuestion[]>;
  abstract formatPrompt(question: BenchmarkQuestion): string;
  abstract extractAnswer(modelResponse: string): string;
  abstract evaluateAnswer(extracted: string, correct: string): Promise<boolean>;

  /** Sample questions with seeded randomization. */
  protected sampleQuestions(
    questions: BenchmarkQuestion[],
    n: number,
    seed: number,
  ): BenchmarkQuestion[] {
    return sampleQuestionsDeterministic(questions, n, seed);
  }

  /** Helper method for calling the model API (delegates to the injected fn). */
  protected callModel(
    url: string,
    apiKey: string,
    prompt: string,
    temperature?: number,
    maxTokens?: number,
    cotSteps?: number,
  ): Promise<ModelCallResult> {
    return this.callModelFn({ url, apiKey, prompt, temperature, maxTokens, cotSteps });
  }

  /** Default implementation of runBenchmark. */
  async runBenchmark(config: BenchmarkConfig): Promise<BenchmarkSummary> {
    const fullDataset = await this.loadDataset();

    const envMaxSamples = readMaxSamplesEnv();
    const defaultSampleSize = envMaxSamples ?? DEFAULT_SAMPLE_SIZE;
    const sampleSize = config.sampleSize ?? defaultSampleSize;
    const seed = config.seed ?? DEFAULT_SEED;
    const repeats = config.repeats ?? this.defaultRepeats;

    const isSampled = fullDataset.length > sampleSize;
    const questions = isSampled ? this.sampleQuestions(fullDataset, sampleSize, seed) : fullDataset;

    console.log(`Running ${this.name} benchmark:`);
    console.log(`  Total questions in dataset: ${fullDataset.length}`);
    console.log(`  Sampled questions: ${questions.length}`);
    console.log(`  Repeats per question: ${repeats}`);
    console.log(`  CoT steps: ${config.cotSteps ?? DEFAULT_COT_STEPS}`);

    const results: BenchmarkResult[] = [];
    let questionIndex = 0;

    for (const question of questions) {
      questionIndex++;
      console.log(`  Processing question ${questionIndex}/${questions.length}...`);

      for (let i = 0; i < repeats; i++) {
        const prompt = this.formatPrompt(question);
        const startTime = Date.now();

        try {
          const { response, cost } = await this.callModel(
            config.modelUrl,
            config.apiKey,
            prompt,
            config.temperature,
            config.maxTokens,
            config.cotSteps,
          );

          const durationMs = Date.now() - startTime;
          const extractedAnswer = this.extractAnswer(response);
          const isCorrect = await this.evaluateAnswer(extractedAnswer, question.correctAnswer);

          results.push({
            questionId: question.id,
            modelResponse: response,
            extractedAnswer,
            isCorrect,
            costCents: cost,
            durationMs,
            metadata: {
              repeatIndex: i,
              cotSteps: config.cotSteps ?? DEFAULT_COT_STEPS,
            },
          });
        } catch (error) {
          console.error(`Error processing question ${question.id}:`, error);
          results.push({
            questionId: question.id,
            modelResponse: `ERROR: ${error instanceof Error ? error.message : 'Unknown error'}`,
            extractedAnswer: '',
            isCorrect: false,
            costCents: 0,
            durationMs: Date.now() - startTime,
            metadata: {
              repeatIndex: i,
              cotSteps: config.cotSteps ?? DEFAULT_COT_STEPS,
              error: true,
            },
          });
        }
      }
    }

    const correctAnswers = results.filter((r) => r.isCorrect).length;
    const totalCost = results.reduce((sum, r) => sum + r.costCents, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

    const summary: BenchmarkSummary = {
      benchmarkName: this.name,
      totalQuestions: fullDataset.length,
      sampledQuestions: questions.length,
      correctAnswers,
      accuracy: results.length > 0 ? (correctAnswers / results.length) * 100 : 0,
      totalCostCents: totalCost,
      totalDurationSeconds: totalDuration / 1000,
      results,
      isSampled,
    };

    console.log(`\n${this.name} Results:`);
    console.log(`  Accuracy: ${summary.accuracy.toFixed(2)}%`);
    console.log(`  Cost: $${(summary.totalCostCents / 100).toFixed(2)}`);
    console.log(`  Duration: ${summary.totalDurationSeconds.toFixed(1)}s`);

    return summary;
  }
}
