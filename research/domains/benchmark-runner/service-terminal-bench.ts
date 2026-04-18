// deno-lint-ignore-file no-console -- benchmark harness uses console for diagnostic output
/**
 * Service layer — Terminal-Bench concrete harness.
 *
 * Terminal-Bench: A benchmark for AI agents in terminal environments.
 * Source: https://www.tbench.ai
 *
 * Uses repetition checker to detect if the agent is stuck in loops.
 */

import type { BenchmarkQuestion } from './types.ts';
import { BaseBenchmarkHarness } from './service-harness.ts';
import { RepetitionChecker } from './service-repetition.ts';
import {
  TERMINAL_BENCH_EXTRACT_LENGTH,
  TERMINAL_BENCH_KEYWORD_PASS_RATIO,
  TERMINAL_BENCH_MIN_REPETITIONS,
  TERMINAL_BENCH_REPETITION_THRESHOLD,
  TERMINAL_BENCH_REPETITION_WINDOW,
} from './config.ts';

const TERMINAL_BENCH_TOTAL_TASKS = 47; // Terminal-Bench Hard has 47 tasks
const TERMINAL_BENCH_DEFAULT_REPEATS = 3; // As per Artificial Analysis

export class TerminalBenchHarness extends BaseBenchmarkHarness {
  readonly name = 'Terminal-Bench';
  readonly description = 'AI agents in terminal environments (tbench.ai)';
  readonly questionCount = TERMINAL_BENCH_TOTAL_TASKS;
  readonly defaultRepeats = TERMINAL_BENCH_DEFAULT_REPEATS;

  loadDataset(): Promise<BenchmarkQuestion[]> {
    // TODO(#deferred): Load from Terminal-Bench registry
    // For now, return sample tasks from https://www.tbench.ai
    console.log('Loading Terminal-Bench dataset...');
    console.warn('Full dataset loading not implemented - using sample tasks');

    return Promise.resolve([
      {
        id: 'terminal-bench-sample-1',
        question:
          'Build linux kernel linux-6.9 from source. Add printk(KERN_INFO "Hello, this is a custom kernel"); to the function start_kernel. Generate the ramfs with gen_init_cpio and run qemu.',
        correctAnswer: 'kernel_built_and_custom_message_added',
        metadata: {
          difficulty: 'medium',
          category: 'system-administration',
          source: 'build-linux-kernel-qemu',
        },
      },
      {
        id: 'terminal-bench-sample-2',
        question:
          'Configure a git server so that I can push changes and have them automatically deployed to a webserver running on port 8080. The webserver should serve the pushed files.',
        correctAnswer: 'git_server_configured_with_auto_deploy',
        metadata: {
          difficulty: 'hard',
          category: 'system-administration',
          source: 'configure-git-webserver',
        },
      },
      {
        id: 'terminal-bench-sample-3',
        question:
          "You need to create a file called '/app/solution.txt' with the word found in 'secret_file.txt' in the 'secrets.7z' archive.",
        correctAnswer: 'password_extracted_from_archive',
        metadata: {
          difficulty: 'medium',
          category: 'security',
          source: 'crack-7z-hash',
        },
      },
    ]);
  }

  formatPrompt(question: BenchmarkQuestion): string {
    return `You are an AI agent with access to a terminal environment. Complete the following task:

Task: ${question.question}

You can use any terminal commands, write scripts, install packages, and perform any necessary operations to complete the task. Provide a step-by-step plan and then execute it.

Respond with your approach and the commands you would run:`;
  }

  extractAnswer(modelResponse: string): string {
    // For terminal tasks, we extract the approach/solution
    // In a real implementation, we would execute the commands and check results
    return modelResponse.substring(0, TERMINAL_BENCH_EXTRACT_LENGTH);
  }

  async evaluateAnswer(extracted: string, correct: string): Promise<boolean> {
    // Terminal-Bench evaluation would involve:
    // 1. Executing the commands in a sandboxed environment
    // 2. Running test suites to verify task completion
    // 3. Using repetition checker to detect stuck agents
    const checker = new RepetitionChecker(
      TERMINAL_BENCH_REPETITION_WINDOW,
      TERMINAL_BENCH_REPETITION_THRESHOLD,
      TERMINAL_BENCH_MIN_REPETITIONS,
    );
    const lines = extracted.split('\n');

    for (const line of lines) {
      checker.addMessage(line);
    }

    const isStuck = await checker.isStuck();

    if (isStuck) {
      console.log('Agent appears stuck in repetition loop');
      return false;
    }

    // TODO(#deferred): Implement actual task verification
    // For sample implementation, we do basic keyword matching
    const keywords = correct.toLowerCase().split('_');
    const responseL = extracted.toLowerCase();
    const matchCount = keywords.filter((kw) => responseL.includes(kw)).length;

    return matchCount >= Math.ceil(keywords.length * TERMINAL_BENCH_KEYWORD_PASS_RATIO);
  }
}
