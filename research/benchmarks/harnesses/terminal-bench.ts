/**
 * Terminal-Bench Harness
 * 
 * Terminal-Bench: A benchmark for AI agents in terminal environments
 * Source: https://www.tbench.ai
 * 
 * Terminal-Bench tests agents' ability to complete real-world terminal tasks like:
 * - System administration
 * - Security tasks
 * - Data processing
 * - Model training
 * - File operations
 * 
 * Uses repetition checker to detect if agent is stuck in loops.
 */

import { BaseBenchmarkHarness, BenchmarkQuestion } from './base.ts';
import { RepetitionChecker } from '../evaluators/repetition-checker.ts';

export class TerminalBenchHarness extends BaseBenchmarkHarness {
  readonly name = "Terminal-Bench";
  readonly description = "AI agents in terminal environments (tbench.ai)";
  readonly questionCount = 47; // Terminal-Bench Hard has 47 tasks
  readonly defaultRepeats = 3;  // Run each task 3 times as per Artificial Analysis
  
  async loadDataset(): Promise<BenchmarkQuestion[]> {
    // TODO: Load from Terminal-Bench registry
    // For now, return sample tasks from https://www.tbench.ai
    console.log('Loading Terminal-Bench dataset...');
    console.warn('Full dataset loading not implemented - using sample tasks');
    
    return [
      {
        id: "terminal-bench-sample-1",
        question: "Build linux kernel linux-6.9 from source. Add printk(KERN_INFO \"Hello, this is a custom kernel\"); to the function start_kernel. Generate the ramfs with gen_init_cpio and run qemu.",
        correctAnswer: "kernel_built_and_custom_message_added",
        metadata: {
          difficulty: "medium",
          category: "system-administration",
          source: "build-linux-kernel-qemu"
        }
      },
      {
        id: "terminal-bench-sample-2",
        question: "Configure a git server so that I can push changes and have them automatically deployed to a webserver running on port 8080. The webserver should serve the pushed files.",
        correctAnswer: "git_server_configured_with_auto_deploy",
        metadata: {
          difficulty: "hard",
          category: "system-administration",
          source: "configure-git-webserver"
        }
      },
      {
        id: "terminal-bench-sample-3",
        question: "You need to create a file called '/app/solution.txt' with the word found in 'secret_file.txt' in the 'secrets.7z' archive.",
        correctAnswer: "password_extracted_from_archive",
        metadata: {
          difficulty: "medium",
          category: "security",
          source: "crack-7z-hash"
        }
      }
    ];
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
    return modelResponse.substring(0, 500); // Keep first 500 chars as the "answer"
  }
  
  async evaluateAnswer(extracted: string, correct: string): Promise<boolean> {
    // Terminal-Bench evaluation would involve:
    // 1. Executing the commands in a sandboxed environment
    // 2. Running test suites to verify task completion
    // 3. Using repetition checker to detect stuck agents
    
    // For now, we check for repetition patterns (agent stuck in loop)
    const checker = new RepetitionChecker(5, 0.99, 3);
    const lines = extracted.split('\n');
    
    // Add messages to the checker
    for (const line of lines) {
      checker.addMessage(line);
    }
    
    const isStuck = await checker.isStuck();
    
    if (isStuck) {
      console.log('Agent appears stuck in repetition loop');
      return false;
    }
    
    // TODO: Implement actual task verification
    // This would involve checking if the task was completed successfully
    // For sample implementation, we do basic keyword matching
    const keywords = correct.toLowerCase().split('_');
    const responseL = extracted.toLowerCase();
    const matchCount = keywords.filter(kw => responseL.includes(kw)).length;
    
    return matchCount >= Math.ceil(keywords.length * 0.5); // At least 50% keywords present
  }
}

