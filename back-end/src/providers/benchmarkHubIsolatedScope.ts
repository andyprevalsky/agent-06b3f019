/** Explicit isolated-R2 scope for a Benchmark Hub experiment service. */

import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import path from 'path';

/** Explicit isolated R2 is never inferred from credentials or a fake Render identity. */
export function isolatedR2Prefix(): string | null {
  if (process.env.BENCHMARK_HUB_STORAGE !== 'r2-isolated') return null;
  const runId = process.env.BENCHMARK_RUN_ID ?? '';
  if (process.env.BENCHMARK_ISOLATED_RUN !== 'true' || !/^hubxp_[0-9a-f]{32}$/.test(runId)) {
    throw new Error('Isolated R2 requires an isolated run and a root-issued scope ID');
  }
  for (const name of [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_TRACE_ARCHIVE',
  ]) {
    if (!process.env[name]?.trim()) throw new Error('Isolated R2 credentials are incomplete');
  }
  const intent = process.env.BENCHMARK_HUB_ISOLATION_INTENT;
  if (!intent || !path.isAbsolute(intent)) throw new Error('Isolated R2 scope intent is required');
  const fd = openSync(intent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 4096
    ) {
      throw new Error('Isolated R2 scope intent ownership refused');
    }
    const scope = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
    if (
      scope.schema !== 'benchmark-hub-r2-isolation-v1' ||
      scope.mode !== 'r2-isolated' ||
      scope.run_id !== runId ||
      scope.bucket !== process.env.R2_BUCKET_TRACE_ARCHIVE
    ) {
      throw new Error('Isolated R2 scope intent binding refused');
    }
  } finally {
    closeSync(fd);
  }
  return `benchmark-hub-isolated/${runId}`;
}

// Fail startup closed for an explicitly requested isolated service.
isolatedR2Prefix();

/**
 * An isolated experiment owns one disjoint prefix with direct conditional
 * writes; it never reads the production legacy archive or epoch overlay.
 */
export function isolatedObjectKey(key: string): string | null {
  const prefix = isolatedR2Prefix();
  if (prefix === null) return null;
  if (
    !/^(?:index|agent-run-index|agent-run-index-revision)\.json$|^(?:runs|visibility)\/[A-Za-z0-9._-]+\.json$/.test(
      key
    )
  ) {
    throw new Error('Isolated R2 object key is outside the Hub scope');
  }
  return prefix;
}
