/**
 * Event-loop stall watchdog.
 *
 *   main thread: heartbeat (SharedArrayBuffer, every HEARTBEAT_MS)
 *   watchdog worker: heartbeat stale > stallMs
 *     -> inspector.Session.connectToMainThread()
 *     -> Debugger.pause (interrupts the busy isolate at its next JS boundary)
 *     -> capture the top call frames -> Debugger.resume
 *     -> one JSON line on fd 2 (bypasses the blocked loop's stdout stream)
 *     -> while paused, read the main isolate's process.memoryUsage()
 *        (heapUsed vs external/arrayBuffers separates JS heap from Buffers)
 *   every line also carries anonymous RSS and the busiest threads' CPU from
 *   /proc, which still works when the main thread is stuck in native code
 *   while the stall lasts: the same sample (frames + memory) every reportEveryMs
 *
 * Why: the backend was OOM-killed at 16 GiB six times (2026-09-18 .. 10-27).
 * Each time the event loop froze for 40-70 s while memory climbed, and every
 * log line written from the main thread stopped, so nothing recorded what was
 * running. This thread survives a blocked main loop and names the code.
 *
 * Cost: one idle worker thread and one main-thread timer per process, the same
 * at 1 or 10k agents. The isolate is paused only during an existing stall.
 */
import { Worker } from 'node:worker_threads';

export interface EventLoopStallWatchdogOptions {
  /** Main loop silence that counts as a stall. */
  stallMs?: number;
  /** Interval between RSS lines while a stall continues. */
  reportEveryMs?: number;
}

const HEARTBEAT_MS = 250;

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const inspector = require('node:inspector');
const fs = require('node:fs');
const beat = new Float64Array(workerData.heartbeat);
const { stallMs, reportEveryMs } = workerData;

function rssMb() {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const match = /VmRSS:\\s+(\\d+)/.exec(status);
    if (match) return Math.round(Number(match[1]) / 1024);
  } catch {}
  return Math.round(process.memoryUsage().rss / 1048576);
}

function anonMb() {
  try {
    const match = /RssAnon:\\s+(\\d+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    if (match) return Math.round(Number(match[1]) / 1024);
  } catch {}
  return undefined;
}

let lastTicks = new Map();
let lastTicksAt = Date.now();
function busyThreads() {
  try {
    const now = Date.now();
    const ticks = new Map();
    const rows = [];
    for (const tid of fs.readdirSync('/proc/self/task')) {
      const stat = fs.readFileSync('/proc/self/task/' + tid + '/stat', 'utf8');
      const close = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, close);
      const fields = stat.slice(close + 2).split(' ');
      const total = Number(fields[11]) + Number(fields[12]);
      ticks.set(tid, total);
      const before = lastTicks.get(tid);
      if (before !== undefined) rows.push({ tid: Number(tid), name, cpu_pct: Math.round(((total - before) * 1000) / Math.max(1, now - lastTicksAt)) });
    }
    lastTicks = ticks;
    lastTicksAt = now;
    return rows.sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 5);
  } catch {
    return undefined;
  }
}

function emit(record) {
  try {
    fs.writeSync(2, JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', component: 'EventLoopStall', ...record }) + '\\n');
  } catch {}
}

function captureMainStack() {
  return new Promise((resolve) => {
    const session = new inspector.Session();
    let settled = false;
    const finish = (frames, error, memory) => {
      if (settled) return;
      settled = true;
      try { session.post('Debugger.resume'); } catch {}
      try { session.disconnect(); } catch {}
      resolve({ frames, error, memory });
    };
    try {
      session.connectToMainThread();
      session.on('Debugger.paused', (message) => {
        const frames = (message.params.callFrames || []).slice(0, 25).map((frame) => ({
          fn: frame.functionName || '(anonymous)',
          url: frame.url,
          line: frame.location.lineNumber + 1,
          column: frame.location.columnNumber + 1,
        }));
        const top = (message.params.callFrames || [])[0];
        if (!top) return finish(frames);
        session.post(
          'Debugger.evaluateOnCallFrame',
          { callFrameId: top.callFrameId, expression: 'JSON.stringify(globalThis.process.memoryUsage())', silent: true, returnByValue: true },
          (error, result) => {
            let memory;
            try {
              const usage = JSON.parse(result.result.value);
              memory = {};
              for (const key of Object.keys(usage)) memory[key + '_mb'] = Math.round(usage[key] / 1048576);
            } catch {}
            finish(frames, undefined, memory);
          }
        );
      });
      session.post('Debugger.enable', () => session.post('Debugger.pause'));
      setTimeout(() => finish([], 'pause timed out'), 5000);
    } catch (error) {
      finish([], String(error && error.message ? error.message : error));
    }
  });
}

let stalledSince = 0;
let lastReport = 0;
let capturing = false;

async function sample(message) {
  capturing = true;
  const { frames, error, memory } = await captureMainStack();
  capturing = false;
  emit({ message, stall_ms: Date.now() - stalledSince, rss_mb: rssMb(), anon_mb: anonMb(), memory, threads: busyThreads(), frames, capture_error: error });
}

setInterval(async () => {
  const now = Date.now();
  const lag = now - beat[0];
  if (lag < stallMs) {
    if (stalledSince !== 0) {
      emit({ message: 'event loop stall ended', stall_ms: now - stalledSince, rss_mb: rssMb(), anon_mb: anonMb() });
    }
    stalledSince = 0;
    return;
  }
  if (capturing) return;
  if (stalledSince === 0) {
    stalledSince = beat[0];
    lastReport = now;
    busyThreads();
    await sample('event loop stall');
    return;
  }
  if (now - lastReport >= reportEveryMs) {
    lastReport = now;
    await sample('event loop stall continues');
  }
}, Math.max(50, Math.min(1000, Math.floor(stallMs / 4))));
`;

let started: Worker | null = null;

export function startEventLoopStallWatchdog(options: EventLoopStallWatchdogOptions = {}): Worker {
  if (started !== null) return started;
  const heartbeat = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT);
  const beat = new Float64Array(heartbeat);
  beat[0] = Date.now();
  const timer = setInterval(() => {
    beat[0] = Date.now();
  }, HEARTBEAT_MS);
  timer.unref();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      heartbeat,
      stallMs: options.stallMs ?? 5_000,
      reportEveryMs: options.reportEveryMs ?? 5_000,
    },
  });
  worker.unref();
  started = worker;
  return worker;
}
