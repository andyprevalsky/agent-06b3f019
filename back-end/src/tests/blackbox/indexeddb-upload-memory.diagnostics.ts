import fs from 'node:fs';

export interface UploadChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  startedAtMs: number;
  finishedAtMs: number;
}

const WATCHDOG_LOG = '/run/boxes-memory-terminations.jsonl';

export function formatUploadChildFailure(
  result: UploadChildResult,
  heapMb: number,
  watchdogLog?: string
): string {
  const failure =
    `ingest must survive a ${heapMb}MB heap — child exited ${result.code}.\n` +
    `--- stdout ---\n${result.stdout}\n--- stderr (tail) ---\n` +
    result.stderr.split('\n').slice(-30).join('\n');
  if (
    result.code === 0 ||
    !/\b57P01\b|terminating connection due to administrator command/i.test(
      `${result.stdout}\n${result.stderr}`
    )
  ) {
    return failure;
  }

  let unavailable = '';
  if (watchdogLog === undefined) {
    try {
      watchdogLog = fs.readFileSync(WATCHDOG_LOG, 'utf8');
    } catch {
      unavailable = ` Watchdog log unavailable: ${WATCHDOG_LOG}.`;
      watchdogLog = '';
    }
  }
  const receipts: Record<string, unknown>[] = [];
  for (const line of watchdogLog.split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    const row = value as Record<string, unknown>;
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (
      row.comm !== 'postgres' ||
      (row.signal !== 'TERM' && row.signal !== 'KILL') ||
      typeof row.pid !== 'number' ||
      !Number.isInteger(row.pid) ||
      row.pid <= 1 ||
      !Number.isFinite(at) ||
      at < result.startedAtMs ||
      at > result.finishedAtMs
    ) {
      continue;
    }
    receipts.push({
      at: row.at,
      signal: row.signal,
      pid: row.pid,
      comm: row.comm,
      source: row.source,
      rssBytes: row.rssBytes,
      memAvailableBytes: row.memAvailableBytes,
    });
  }
  const evidence = receipts.length
    ? 'Watchdog receipt correlation (host PIDs; database backend identity is not confirmed):\n' +
      receipts.map((row) => JSON.stringify(row)).join('\n')
    : `No matching Postgres watchdog receipt in this child interval; 57P01 alone does not identify the sender.${unavailable}`;
  return (
    `${failure}\n--- Postgres termination ---\n` +
    'Postgres connection terminated by an administrator action or SIGTERM (SQLSTATE 57P01); ' +
    'the heap-survival assertion failed upstream in Postgres.\n' +
    evidence
  );
}
