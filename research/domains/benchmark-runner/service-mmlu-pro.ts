// deno-lint-ignore-file no-console -- benchmark harness uses console for dataset loading diagnostics
/**
 * Service layer — MMLU-Pro concrete harness.
 *
 * Multi-Task Language Understanding Benchmark, Pro version.
 * 12,032 questions, 10-choice MCQ. Uses regex extraction for answer evaluation.
 */

import type { BenchmarkQuestion } from './types.ts';
import { BaseBenchmarkHarness } from './service-harness.ts';

const MMLU_PRO_TOTAL_QUESTIONS = 12032;
const MMLU_PRO_DEFAULT_REPEATS = 1;

export class MMLUProHarness extends BaseBenchmarkHarness {
  readonly name = 'MMLU-Pro';
  readonly description = 'Multi-Task Language Understanding Benchmark, Pro version';
  readonly questionCount = MMLU_PRO_TOTAL_QUESTIONS;
  readonly defaultRepeats = MMLU_PRO_DEFAULT_REPEATS;

  loadDataset(): Promise<BenchmarkQuestion[]> {
    // TODO(#deferred): Load from HuggingFace datasets library
    // For now, return sample questions
    console.log('Loading MMLU-Pro dataset...');
    console.warn('Full dataset loading not implemented - using sample questions');

    return Promise.resolve([
      {
        id: 'mmlu-pro-sample-1',
        question: 'What is the capital of France?',
        options: [
          'A) London',
          'B) Berlin',
          'C) Paris',
          'D) Madrid',
          'E) Rome',
          'F) Vienna',
          'G) Brussels',
          'H) Amsterdam',
          'I) Zurich',
          'J) Copenhagen',
        ],
        correctAnswer: 'C',
      },
      {
        id: 'mmlu-pro-sample-2',
        question: 'In computer science, what does CPU stand for?',
        options: [
          'A) Central Processing Unit',
          'B) Computer Personal Unit',
          'C) Central Program Utility',
          'D) Computer Processing Utility',
          'E) Central Peripheral Unit',
          'F) Central Power Unit',
          'G) Computer Peripheral Unit',
          'H) Central Program Unit',
          'I) Computer Power Utility',
          'J) Central Personal Unit',
        ],
        correctAnswer: 'A',
      },
      {
        id: 'mmlu-pro-sample-3',
        question: 'What is the largest planet in our solar system?',
        options: [
          'A) Earth',
          'B) Mars',
          'C) Jupiter',
          'D) Saturn',
          'E) Neptune',
          'F) Uranus',
          'G) Venus',
          'H) Mercury',
          'I) Pluto',
          'J) None of the above',
        ],
        correctAnswer: 'C',
      },
    ]);
  }

  formatPrompt(question: BenchmarkQuestion): string {
    const optionsText = question.options?.join('\n') ?? '';

    return `The following is a multiple choice question. Choose the best answer from the options provided.

Question: ${question.question}

${optionsText}

Answer with only the letter of your choice (A-J):`;
  }

  extractAnswer(modelResponse: string): string {
    // Try to extract single letter answer (A-J)
    // Look for standalone letter or letter followed by )
    const match = modelResponse.match(/\b([A-J])\b/i);
    if (match) {
      return match[1].toUpperCase();
    }

    // Try to match "Answer: X" or "The answer is X"
    const answerMatch = modelResponse.match(/(?:answer|choice|option)(?:\s+is)?[\s:]+([A-J])/i);
    if (answerMatch) {
      return answerMatch[1].toUpperCase();
    }

    return '';
  }

  evaluateAnswer(extracted: string, correct: string): Promise<boolean> {
    // Simple string comparison for multiple choice
    return Promise.resolve(extracted.toUpperCase() === correct.toUpperCase());
  }
}
