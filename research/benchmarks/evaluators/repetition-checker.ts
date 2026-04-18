/**
 * Re-export shim: real implementation lives in
 *   research/domains/benchmark-runner/service-repetition.ts
 *   research/domains/benchmark-runner/types.ts
 *
 * Preserves the legacy import path used by the read-only blackbox test file.
 */

export {
  analyzeRepetition,
  checkRepetition,
  messageSimilarity,
  RepetitionChecker,
} from '../../domains/benchmark-runner/service-repetition.ts';

export type { RepetitionAnalysis } from '../../domains/benchmark-runner/types.ts';
