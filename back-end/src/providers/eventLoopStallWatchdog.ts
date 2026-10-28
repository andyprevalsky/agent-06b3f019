/**
 * Event-loop stall watchdog.
 *
 *   main thread: heartbeat (SharedArrayBuffer, every HEARTBEAT_MS)
 *   watchdog worker: heartbeat stale > stallMs
 *     -> inspector.Session.connectToMainThread()
 *     -> Debugger.pause (interrupts the busy isolate at its next JS boundary)
 *     -> capture the top call frames -> Debugger.resume
 *     -> one JSON line on fd 2 (bypasses the blocked loop's stdout stream)
 *   while the stall lasts: RSS line every reportEveryMs
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

function emit(record) {
  try {
    fs.writeSync(2, JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', component: 'EventLoopStall', ...record }) + '\\n');
  } catch {}
}

function captureMainStack() {
  return new Promise((resolve) => {
    const session = new inspector.Session();
    let settled = false;
    const finish = (frames, error) => {
      if (settled) return;
      settled = true;
      try { session.post('Debugger.resume'); } catch {}
      try { session.disconnect(); } catch {}
      resolve({ frames, error });
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
        finish(frames);
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
setInterval(async () => {
  const now = Date.now();
  const lag = now - beat[0];
  if (lag < stallMs) {
    if (stalledSince !== 0) {
      emit({ message: 'event loop stall ended', stall_ms: now - stalledSince, rss_mb: rssMb() });
    }
    stalledSince = 0;
    return;
  }
  if (stalledSince === 0) {
    stalledSince = beat[0];
    lastReport = now;
    if (capturing) return;
    capturing = true;
    const { frames, error } = await captureMainStack();
    capturing = false;
    emit({ message: 'event loop stall', stall_ms: Date.now() - stalledSince, rss_mb: rssMb(), frames, capture_error: error });
    return;
  }
  if (now - lastReport >= reportEveryMs) {
    lastReport = now;
    emit({ message: 'event loop stall continues', stall_ms: now - stalledSince, rss_mb: rssMb() });
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
