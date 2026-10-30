/**
 * Event-loop stall watchdog.
 *
 *   main thread: heartbeat (SharedArrayBuffer, every HEARTBEAT_MS)
 *   watchdog worker: heartbeat stale > stallMs
 *     -> one memory line at once: RSS, anonymous RSS, CPU per thread, the
 *        container cgroup's memory (anon/file/sock) and the largest processes
 *        (the 16 GiB limit counts every process in the container)
 *     -> then, without blocking further memory lines, a stack capture:
 *     -> inspector.Session.connectToMainThread()
 *     -> Debugger.pause (interrupts the busy isolate at its next JS boundary)
 *     -> capture the top call frames -> Debugger.resume
 *     -> while paused, read the main isolate's process.memoryUsage()
 *        (heapUsed vs external/arrayBuffers separates JS heap from Buffers)
 *     -> a separate 'event loop stall stack' line; 'pause timed out' means the
 *        main thread is inside native code
 *   while the stall lasts: a memory line and a fresh capture every reportEveryMs
 *   every line is written to fd 2 (bypasses the blocked loop's stdout stream)
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

// The cgroup limit counts every process in the container, so name the biggest.
function containerProcesses() {
  try {
    const page = 4096;
    const rows = [];
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\\d+$/.test(pid)) continue;
      try {
        const rss = Number(fs.readFileSync('/proc/' + pid + '/statm', 'utf8').split(' ')[1]) * page;
        const comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim();
        rows.push({ pid: Number(pid), comm, rss_mb: Math.round(rss / 1048576) });
      } catch {}
    }
    return rows.sort((a, b) => b.rss_mb - a.rss_mb).slice(0, 5);
  } catch {
    return undefined;
  }
}

function cgroupMemory() {
  try {
    const stat = fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
    const field = (name) => {
      const match = new RegExp('^' + name + ' ([0-9]+)$', 'm').exec(stat);
      return match ? Math.round(Number(match[1]) / 1048576) : undefined;
    };
    let current;
    try { current = Math.round(Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')) / 1048576); } catch {}
    return { current_mb: current, anon_mb: field('anon'), file_mb: field('file'), sock_mb: field('sock') };
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
    const post = (method, params, callback) => {
      if (settled) return;
      try {
        session.post(method, params, (error, result) => {
          if (!settled && callback) callback(error, result);
        });
      } catch (error) {
        finish([], String(error && error.message ? error.message : error));
      }
    };
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
        if (settled) return;
        const frames = (message.params.callFrames || []).slice(0, 25).map((frame) => ({
          fn: frame.functionName || '(anonymous)',
          url: frame.url,
          line: frame.location.lineNumber + 1,
          column: frame.location.columnNumber + 1,
        }));
        const top = (message.params.callFrames || [])[0];
        if (!top) return finish(frames);
        post(
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
      post('Debugger.enable', {}, () => post('Debugger.pause', {}));
      // A main thread inside native code (zlib, JSON, Buffer, sharp) never reaches
      // a pause point; the timeout names that case instead of waiting forever.
      setTimeout(() => finish([], 'pause timed out: main thread did not reach JavaScript'), 5000);
    } catch (error) {
      finish([], String(error && error.message ? error.message : error));
    }
  });
}

let stalledSince = 0;
let lastReport = 0;
let capturing = false;

function memorySample(message) {
  const usage = process.memoryUsage();
  emit({
    message,
    stall_ms: Date.now() - stalledSince,
    rss_mb: rssMb(),
    anon_mb: anonMb(),
    process_memory: { rss_mb: Math.round(usage.rss / 1048576) },
    cgroup: cgroupMemory(),
    processes: containerProcesses(),
    threads: busyThreads(),
  });
}

function captureStack() {
  if (capturing) return;
  capturing = true;
  const since = stalledSince;
  captureMainStack().then(({ frames, error, memory }) => {
    capturing = false;
    emit({ message: 'event loop stall stack', stall_ms: Date.now() - since, rss_mb: rssMb(), anon_mb: anonMb(), memory, frames, capture_error: error });
  });
}

// Memory lines never wait on a stack capture: when the main thread is stuck in
// native code the capture cannot complete, and those are the lines that matter.
setInterval(() => {
  const now = Date.now();
  const lag = now - beat[0];
  if (lag < stallMs) {
    if (stalledSince !== 0) {
      emit({ message: 'event loop stall ended', stall_ms: now - stalledSince, rss_mb: rssMb(), anon_mb: anonMb() });
    }
    stalledSince = 0;
    return;
  }
  if (stalledSince === 0) {
    stalledSince = beat[0];
    lastReport = now;
    busyThreads();
    memorySample('event loop stall');
    captureStack();
    return;
  }
  if (now - lastReport >= reportEveryMs) {
    lastReport = now;
    memorySample('event loop stall continues');
    captureStack();
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
  worker.on('error', (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', component: 'EventLoopStall', message: 'watchdog worker failed', error: String(error) })}\n`
    );
  });
  worker.unref();
  started = worker;
  return worker;
}
