/**
 * Re-export shim: real implementation lives in
 *   research/domains/benchmark-runner/service-harness.ts
 *   research/domains/benchmark-runner/types.ts
 *
 * This shim preserves the legacy import path used by the read-only blackbox
 * test file.
 */

export type {
  BenchmarkConfig,
  BenchmarkQuestion,
  BenchmarkResult,
  BenchmarkSummary,
  IBenchmarkHarness,
} from '../../domains/benchmark-runner/types.ts';

export { BaseBenchmarkHarness } from '../../domains/benchmark-runner/service-harness.ts';
