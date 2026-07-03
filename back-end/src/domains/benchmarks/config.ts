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
