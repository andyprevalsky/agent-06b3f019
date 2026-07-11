import fs from 'fs';
import path from 'path';

/** Absolute path to the benchmark task definitions JSON file. */
export const TASKS_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'agents',
  'benchmarks',
  'tasks.json'
);

/**
 * Reads and parses the benchmark task catalog from disk.
 * File system access lives here per the no-restricted-imports rule
 * (fs is restricted to config.ts / providers).
 */
export function readTasksFile(): unknown {
  return JSON.parse(fs.readFileSync(TASKS_PATH, 'utf-8'));
}

export function benchmarkAgentPreviewEnabled(): boolean {
  const enabledValues = new Set(['1', 'true', 'yes', 'on']);
  // Defense-in-depth: the preview is unauthenticated and RLS-free, so it must
  // NEVER be reachable on the canonical prod backend even if a benchmark flag
  // leaks into that environment. Render sets RENDER=true on its services, so we
  // hard-disable there regardless of the benchmark flags below. Isolated
  // benchmark stacks (local + Fly cloudbench boxes) don't set RENDER.
  if (enabledValues.has(String(process.env.RENDER ?? '').toLowerCase())) return false;
  return (
    enabledValues.has(String(process.env.BENCHMARK_MODE ?? '').toLowerCase()) ||
    enabledValues.has(String(process.env.BENCHMARK_ISOLATED_RUN ?? '').toLowerCase())
  );
}
