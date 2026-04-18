/**
 * Service layer — repetition detection.
 *
 * Layer boundaries (import rules):
 *   - May import from own types, own config.
 *   - Pure algorithms over already-collected messages.
 */

import type { RepetitionAnalysis } from './types.ts';
import {
  DEFAULT_MIN_REPETITIONS,
  DEFAULT_REPETITION_WINDOW,
  DEFAULT_SIMILARITY_THRESHOLD,
} from './config.ts';

function cosineSimilarity(a: string, b: string): number {
  // Simple word-based cosine similarity
  const wordsA = a.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  const wordsB = b.toLowerCase().split(/\s+/).filter((w) => w.length > 0);

  if (wordsA.length === 0 || wordsB.length === 0) {
    return 0;
  }

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  const intersection = new Set([...setA].filter((x) => setB.has(x)));

  // Cosine similarity = |A ∩ B| / sqrt(|A| * |B|)
  return intersection.size / Math.sqrt(setA.size * setB.size);
}

/**
 * Check if agent is stuck in a repetition loop.
 *
 * @param messages - Array of agent messages (chronological order)
 * @param similarityThreshold - Similarity threshold (default: 0.99 = 99%)
 * @param minRepetitions - Minimum number of consecutive similar messages (default: 3)
 * @returns true if stuck in loop, false otherwise
 */
export function checkRepetition(
  messages: string[],
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  minRepetitions: number = DEFAULT_MIN_REPETITIONS,
): boolean {
  if (messages.length < minRepetitions + 1) {
    return false; // Need at least minRepetitions + 1 messages to detect loop
  }

  // Check last N messages for similarity
  const checkWindow = minRepetitions + 1;
  const recentMessages = messages.slice(-checkWindow);

  // Count consecutive similar messages
  let consecutiveSimilar = 0;

  for (let i = 0; i < recentMessages.length - 1; i++) {
    const similarity = cosineSimilarity(recentMessages[i], recentMessages[i + 1]);

    if (similarity >= similarityThreshold) {
      consecutiveSimilar++;
    } else {
      // Reset count if we find a different message
      consecutiveSimilar = 0;
    }

    // If we found minRepetitions consecutive similar messages, it's a loop
    if (consecutiveSimilar >= minRepetitions) {
      // deno-lint-ignore no-console -- benchmark diagnostic output
      console.log(
        `Repetition detected: ${consecutiveSimilar} consecutive messages with ${
          (similarity * 100).toFixed(1)
        }% similarity`,
      );
      return true;
    }
  }

  return false;
}

/** Get similarity between two messages. */
export function messageSimilarity(msg1: string, msg2: string): number {
  return cosineSimilarity(msg1, msg2);
}

/** Analyze a message sequence for repetition patterns. */
export function analyzeRepetition(
  messages: string[],
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): RepetitionAnalysis {
  if (messages.length < 2) {
    return {
      isRepeating: false,
      maxConsecutiveSimilar: 0,
      avgSimilarity: 0,
      similarityScores: [],
    };
  }

  const similarities: number[] = [];
  let maxConsecutive = 0;
  let currentConsecutive = 0;

  for (let i = 0; i < messages.length - 1; i++) {
    const similarity = cosineSimilarity(messages[i], messages[i + 1]);
    similarities.push(similarity);

    if (similarity >= similarityThreshold) {
      currentConsecutive++;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }

  const avgSimilarity = similarities.reduce((sum, s) => sum + s, 0) / similarities.length;

  return {
    isRepeating: maxConsecutive >= DEFAULT_MIN_REPETITIONS,
    maxConsecutiveSimilar: maxConsecutive,
    avgSimilarity,
    similarityScores: similarities,
  };
}

/**
 * Stateful repetition checker that accumulates messages and detects loops.
 * Used by harnesses (e.g., Terminal-Bench) that process messages incrementally.
 */
export class RepetitionChecker {
  private messages: string[] = [];
  private readonly windowSize: number;
  private readonly similarityThreshold: number;
  private readonly minRepetitions: number;

  constructor(
    windowSize: number = DEFAULT_REPETITION_WINDOW,
    similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
    minRepetitions: number = DEFAULT_MIN_REPETITIONS,
  ) {
    this.windowSize = windowSize;
    this.similarityThreshold = similarityThreshold;
    this.minRepetitions = minRepetitions;
  }

  addMessage(message: string): void {
    this.messages.push(message);
    if (this.messages.length > this.windowSize) {
      this.messages = this.messages.slice(-this.windowSize);
    }
  }

  isStuck(): Promise<boolean> {
    return Promise.resolve(
      checkRepetition(this.messages, this.similarityThreshold, this.minRepetitions),
    );
  }

  getMessages(): string[] {
    return [...this.messages];
  }
}
