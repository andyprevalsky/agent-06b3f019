/** Utilities for the benchmark post-run archive frontend. */

export function isBenchmarkArchiveMode(): boolean {
  return import.meta.env.VITE_BENCHMARK_ARCHIVE === '1';
}

