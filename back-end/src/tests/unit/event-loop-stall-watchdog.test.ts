#!/usr/bin/env tsx
/**
 * Event-loop stall watchdog: a blocked main loop that grows memory is named.
 *
 * Prod OOM kills (2026-09-18 .. 2026-10-27) froze the event loop for 40-70 s
 * while RSS climbed to 16 GiB, and no main-thread log line survived. This child
 * process blocks its loop in `oomStallReproLoop` while allocating Buffers, the
 * same signature. The watchdog must write, from its own thread, one stderr line
 * that names the blocking frame and reports RSS, the main isolate's heap vs
 * Buffer split and per-thread CPU, keeps sampling, then writes a recovery line.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PROVIDER = path.resolve(__dirname, '../../providers/eventLoopStallWatchdog.ts');

const CHILD = `
const { startEventLoopStallWatchdog } = require(${JSON.stringify(PROVIDER)});
startEventLoopStallWatchdog({ stallMs: 300, reportEveryMs: 200 });
function oomStallReproLoop(ms) {
  const retained = [];
  const until = Date.now() + ms;
  while (Date.now() < until) retained.push(Buffer.alloc(1024 * 1024, 1));
  return retained.length;
}
setTimeout(() => {
  oomStallReproLoop(1500);
  setTimeout(() => process.exit(0), 1200);
}, 600);
`;

const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', CHILD], {
  cwd: path.resolve(__dirname, '../../..'),
  encoding: 'utf8',
  timeout: 30_000,
});
assert.equal(result.status, 0, `child failed: ${result.stderr}`);

const records = result.stderr
  .split('\n')
  .filter((line) => line.includes('"component":"EventLoopStall"'))
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const stall = records.find((record) => record.message === 'event loop stall');
assert(stall, `no stall record on stderr:\n${result.stderr}`);
const frames = stall.frames as Array<{ fn: string }>;
assert(
  frames.some((frame) => frame.fn === 'oomStallReproLoop'),
  `the stall record must name the blocking frame: ${JSON.stringify(frames)}`
);
assert(typeof stall.rss_mb === 'number' && stall.rss_mb > 0, 'stall record reports RSS');
const memory = stall.memory as Record<string, number> | undefined;
assert(
  memory && typeof memory.heapUsed_mb === 'number' && typeof memory.arrayBuffers_mb === 'number',
  `the stall record splits the main isolate's heap from Buffers: ${JSON.stringify(memory)}`
);
assert(typeof stall.anon_mb === 'number', 'the stall record reports anonymous RSS');
const threads = stall.threads as Array<{ tid: number; cpu_pct: number }> | undefined;
assert(
  Array.isArray(threads) && threads.some((thread) => thread.tid === result.pid),
  `the stall record shows the main thread's CPU: ${JSON.stringify(threads)}`
);
const continues = records.filter((record) => record.message === 'event loop stall continues');
assert(continues.length > 0, 'RSS is reported again while the stall lasts');
assert(
  continues.some((record) =>
    (record.frames as Array<{ fn: string }>).some((frame) => frame.fn === 'oomStallReproLoop')
  ),
  'later samples name the blocking frame again'
);
const late = continues[continues.length - 1].memory as Record<string, number>;
assert(
  late.arrayBuffers_mb > (memory?.arrayBuffers_mb ?? 0),
  `the off-heap Buffer growth is visible across samples: ${memory?.arrayBuffers_mb} -> ${late.arrayBuffers_mb}`
);
assert(
  records.some((record) => record.message === 'event loop stall ended'),
  'the end of the stall is recorded'
);
process.stdout.write('PASS event-loop stall watchdog names the blocking frame and reports RSS\n');
