#!/usr/bin/env tsx
/**
 * Event-loop stall watchdog: a blocked main loop that grows memory is named.
 *
 * Prod OOM kills (2026-09-18 .. 2026-10-30) froze the event loop for 40-70 s
 * while RSS climbed to 16 GiB, and no main-thread log line survived.
 *
 * Case 1: a child blocks its loop in JavaScript (`oomStallReproLoop`) while
 * allocating Buffers. The watchdog must write a memory line, then a stack line
 * that names the blocking frame and splits the heap from Buffers, keep
 * sampling, and record the end of the stall.
 *
 * Case 2 (the 2026-10-30 19:24Z kill): a child blocks its loop inside native
 * code that never reaches a JavaScript pause point. The killed instance wrote
 * no watchdog line in 47 s because the memory line waited on a stack capture
 * that could not complete, and the late inspector callback then crashed the
 * worker. Memory lines must be written during the block, the capture must
 * time out without crashing, and the child must exit cleanly.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PROVIDER = path.resolve(__dirname, '../../providers/eventLoopStallWatchdog.ts');

type StallRecord = Record<string, unknown> & { message: string; stall_ms: number };

function runChild(body: string): { records: StallRecord[]; stderr: string } {
  const child = `
const { startEventLoopStallWatchdog } = require(${JSON.stringify(PROVIDER)});
${body}
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', child], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `child failed (${result.status}): ${result.stderr}`);
  const records = result.stderr
    .split('\n')
    .filter((line) => line.includes('"component":"EventLoopStall"'))
    .map((line) => JSON.parse(line) as StallRecord);
  return { records, stderr: result.stderr };
}

// Case 1: JavaScript loop allocating Buffers.
{
  const { records, stderr } = runChild(`
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
`);
  const stall = records.find((record) => record.message === 'event loop stall');
  assert(stall, `no stall record on stderr:\n${stderr}`);
  assert(typeof stall.rss_mb === 'number' && stall.rss_mb > 0, 'stall record reports RSS');
  assert(typeof stall.anon_mb === 'number', 'stall record reports anonymous RSS');
  const threads = stall.threads as Array<{ tid: number; cpu_pct: number }> | undefined;
  assert(Array.isArray(threads) && threads.length > 0, 'stall record shows per-thread CPU');

  const stacks = records.filter((record) => record.message === 'event loop stall stack');
  assert(stacks.length > 0, `no stack record:\n${stderr}`);
  const named = stacks.filter((record) =>
    (record.frames as Array<{ fn: string }>).some((frame) => frame.fn === 'oomStallReproLoop')
  );
  assert(
    named.length > 0,
    `a stack record must name the blocking frame: ${JSON.stringify(stacks)}`
  );
  const first = named[0].memory as Record<string, number> | undefined;
  assert(
    first && typeof first.heapUsed_mb === 'number' && typeof first.arrayBuffers_mb === 'number',
    `the stack record splits the main isolate's heap from Buffers: ${JSON.stringify(first)}`
  );
  const last = named[named.length - 1].memory as Record<string, number>;
  assert(
    named.length < 2 || last.arrayBuffers_mb > first.arrayBuffers_mb,
    `the off-heap Buffer growth is visible across samples: ${first.arrayBuffers_mb} -> ${last.arrayBuffers_mb}`
  );
  assert(
    records.some((record) => record.message === 'event loop stall continues'),
    'memory is reported again while the stall lasts'
  );
  assert(
    records.some((record) => record.message === 'event loop stall ended'),
    'the end of the stall is recorded'
  );
}

// Case 2: native code that never reaches a JavaScript pause point.
{
  const { records, stderr } = runChild(`
startEventLoopStallWatchdog({ stallMs: 300, reportEveryMs: 500 });
const crypto = require('node:crypto');
setTimeout(() => {
  const started = Date.now();
  while (Date.now() - started < 7000) crypto.pbkdf2Sync('x', 'y', 200000, 64, 'sha512');
  process.stderr.write('NATIVE_BLOCK_MS=' + (Date.now() - started) + '\\n');
  setTimeout(() => process.exit(0), 1500);
}, 500);
`);
  const blockMs = Number(/NATIVE_BLOCK_MS=(\d+)/.exec(stderr)?.[1]);
  assert(blockMs >= 6500, `native block ran: ${stderr}`);
  const stall = records.find((record) => record.message === 'event loop stall');
  assert(stall, `no stall record during a native block:\n${stderr}`);
  assert(
    stall.stall_ms < 2000,
    `the first memory line is written at once, not after the block: ${stall.stall_ms} ms`
  );
  const during = records.filter(
    (record) => record.message === 'event loop stall continues' && record.stall_ms < blockMs
  );
  assert(during.length >= 3, `memory lines continue during the block: ${during.length}`);
  assert(
    !stderr.includes('watchdog worker failed') && !stderr.includes('ERR_INSPECTOR'),
    `the watchdog worker must survive a capture timeout:\n${stderr}`
  );
  assert(
    records.some((record) => record.message === 'event loop stall ended'),
    'the end of the native stall is recorded'
  );
}

process.stdout.write('PASS event-loop stall watchdog reports JS and native-code stalls\n');
