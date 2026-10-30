import assert from 'node:assert/strict';
import {
  formatUploadChildFailure,
  type UploadChildResult,
} from './indexeddb-upload-memory.diagnostics';

// Captured shard-2 failure and watchdog record, 2026-10-28. No database or
// process is signalled: this checks the reporting boundary with the real data.
const failed: UploadChildResult = {
  code: 1,
  stdout:
    'Raw query failed. Code: `57P01`. Message: `FATAL: terminating connection due to administrator command`',
  stderr: 'PrismaClientKnownRequestError at bindUploadDocument',
  startedAtMs: Date.parse('2026-10-28T17:48:05.168Z'),
  finishedAtMs: Date.parse('2026-10-28T17:48:10.514Z'),
};
const receipt = {
  at: '2026-10-28T17:48:09.839Z',
  signal: 'TERM',
  pid: 1711139,
  comm: 'postgres',
  rssBytes: 286908416,
  source: 'whole_machine',
  memAvailableBytes: 1007181824,
};

// Passing captured log text keeps this fixture independent of the current
// host's watchdog history.
const formatWithLog: (result: UploadChildResult, heapMb: number, log: string) => string =
  formatUploadChildFailure;
const formatted = formatWithLog(failed, 256, JSON.stringify(receipt));
assert.match(formatted, /Postgres connection terminated.*57P01/);
assert.match(formatted, /watchdog.*correlation/i);
assert.match(formatted, /1711139/);
assert.match(formatted, /17:48:09\.839Z/);
assert.match(formatted, /1007181824/);
assert.match(formatted, /child exited 1/);
process.stdout.write(
  'PASS administrator termination includes the matching watchdog receipt and preserves failure\n'
);

const unrelated = [
  { ...receipt, at: '2026-10-28T17:47:09.839Z', pid: 11 },
  { ...receipt, at: '2026-10-28T17:49:09.839Z', pid: 12 },
  { ...receipt, comm: 'node', pid: 13 },
  { ...receipt, signal: 'STOP', pid: 14 },
  { ...receipt, at: 'invalid', pid: 15 },
]
  .map((row) => JSON.stringify(row))
  .join('\n');
const withoutMatch = formatWithLog(failed, 256, `${unrelated}\nmalformed JSON`);
assert.match(withoutMatch, /no matching.*watchdog/i);
for (const pid of [11, 12, 13, 14, 15]) {
  assert.doesNotMatch(withoutMatch, new RegExp(`"pid":${pid}\\b`));
}
process.stdout.write(
  'PASS stale, future, unrelated, and malformed watchdog records are not attributed\n'
);

const oom = formatWithLog(
  { ...failed, stdout: '', stderr: 'FATAL ERROR: heap out of memory' },
  256,
  JSON.stringify(receipt)
);
assert.doesNotMatch(oom, /Postgres connection terminated|watchdog/i);
assert.match(oom, /heap out of memory/);
process.stdout.write('PASS a V8 heap failure is not mislabeled as Postgres termination\n');
