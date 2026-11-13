import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

type Fps = { frames: number; p50: number | null; p5: number | null };
type Result = { normal: { fpsWindows: number; fps: Fps; workers: { fps: Fps }[] } };
interface Api {
  measureRoute(...args: unknown[]): Promise<Result>;
  evaluateBudgets(result: unknown): {
    violations: { rule: string }[];
    warnings: { rule: string; message: string }[];
  };
}
const cliPath = resolve(__dirname, '../../assets/user-ui/bin/rose-ui.cjs');
const samples = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/user-ui/fps-windows.json'), 'utf8')
);
type Frames = number[] | null;
// rAF timestamps for the given frame deltas (ms); frameStats sorts deltas, so order is irrelevant.
const cadence = (deltas: number[]) =>
  deltas.reduce((times, delta) => [...times, times[times.length - 1] + delta], [1000]);
const vsync = 1000 / 60;
// 50/50 fps p50/p5: steady 50 Hz misses only the p50 budget.
const steady50 = cadence(Array(40).fill(20));
// 60/30 fps p50/p5: one missed refresh at p95 meets both budgets.
const passing60 = cadence([...Array(36).fill(vsync), ...Array(4).fill(2 * vsync)]);
// 60/20 fps p50/p5: two missed refreshes at p95 miss the p5 budget.
const failing60 = cadence([...Array(36).fill(vsync), ...Array(4).fill(3 * vsync)]);

// Browser IO is replaced; actual measureWindow, workerCall, measureRoute and budgets run.
async function measure(options: {
  main?: number[][];
  workers?: Frames[][];
  reverseRetry?: boolean;
  longTask?: boolean;
  /** Host CPU counters read around each fps window; none (no /proc) by default. */
  hostCpu?: { busy: number; total: number; own: number }[];
}) {
  const main = [...(options.main ?? [samples.fast, samples.fast])];
  const workers = (options.workers ?? [[samples.slow, samples.fast]]).map((sequence) => {
    const remaining = [...sequence];
    return {
      evaluate: async (fn: () => unknown) => {
        if (!String(fn).includes('frames.slice')) return;
        const frames = remaining.shift();
        if (!frames) throw new Error('worker snapshot unavailable');
        return { frames, raf: frames.length, timers: 0 };
      },
    };
  });
  const frame = {
    evaluate: async (fn: () => unknown) =>
      String(fn).includes('snapshot()')
        ? {
            frames: main.shift() ?? samples.fast,
            longTasks: [],
            shifts: [],
            errors: [],
            animations: [],
            dataset: {},
          }
        : undefined,
  };
  const sandbox = {
    module: { exports: {} as Api },
    require: createRequire(cliPath),
    __dirname: dirname(cliPath),
    process,
    Buffer,
    console,
    setTimeout: (callback: () => void) => callback(),
    workers,
    frame,
    reverseRetry: options.reverseRetry,
    tasks: options.longTask ? [{ phase: 'steady', duration: 100, cpu: 100, pageWait: 0 }] : [],
    hostCpuSamples: [...(options.hostCpu ?? [])],
  };
  runInNewContext(
    readFileSync(cliPath, 'utf8') +
      `
    openHost = async () => ({ page: {}, workers, context: { close: async () => {} }, bytes: { total: 0 } });
    userFrames = () => [frame];
    hostCpuSample = () => hostCpuSamples.shift() ?? null;
    const originalWindow = measureWindow;
    let windowCalls = 0;
    measureWindow = async (...args) => {
      const result = await originalWindow(...args);
      if (++windowCalls === 2 && reverseRetry) result.workerSnaps.reverse();
      return result;
    };
    tracedWindow = async (_browser, page, preview, ws, ms) => ({ ...await measureWindow(page, preview, ws, ms), tasks });
    module.exports.measureRoute = measureRoute;
  `,
    sandbox,
    { filename: cliPath }
  );
  const result = await sandbox.module.exports.measureRoute({}, {}, '/', {
    viewport: { width: 1280, height: 800 },
    seconds: 2,
    settleMs: 1000,
    retryFps: true,
    hidden: false,
    reducedMotion: false,
  });
  return {
    result,
    verdict: sandbox.module.exports.evaluateBudgets({
      static: { violations: [], warnings: [] },
      ...result,
    }),
  };
}
for (const worker of [true, false]) {
  test(`${worker ? 'worker' : 'main'} valid retry wins tied p5`, async () => {
    const { verdict } = await measure(
      worker ? {} : { main: [samples.slow, samples.fast], workers: [] }
    );
    assert.deepEqual(Array.from(verdict.violations), []);
  });
  test(`${worker ? 'worker' : 'main'} five-frame retry cannot erase measured failure`, async () => {
    const short = samples.fast.slice(1, 6);
    const { result, verdict } = await measure(
      worker ? { workers: [[samples.slow, short]] } : { main: [samples.slow, short], workers: [] }
    );
    assert.equal(
      (worker ? result.normal.workers[0].fps : result.normal.fps).frames,
      samples.slow.length
    );
    assert.ok(verdict.violations.some((v) => v.rule === 'fps-p50'));
  });
  test(`${worker ? 'worker' : 'main'} passing retry beats failing window with higher p5`, async () => {
    const { result, verdict } = await measure(
      worker ? { workers: [[steady50, passing60]] } : { main: [steady50, passing60], workers: [] }
    );
    const fps = worker ? result.normal.workers[0].fps : result.normal.fps;
    assert.deepEqual([fps.p50, fps.p5], [60, 30]);
    assert.deepEqual(Array.from(verdict.violations), []);
  });
  test(`${worker ? 'worker' : 'main'} two failing windows keep p5 ranking`, async () => {
    const { result, verdict } = await measure(
      worker ? { workers: [[steady50, failing60]] } : { main: [steady50, failing60], workers: [] }
    );
    const fps = worker ? result.normal.workers[0].fps : result.normal.fps;
    assert.deepEqual([fps.p50, fps.p5], [50, 50]);
    assert.deepEqual(
      Array.from(verdict.violations, (v) => v.rule),
      ['fps-p50']
    );
  });
}
test('missing retry worker A cannot borrow healthy worker B', async () => {
  const { result, verdict } = await measure({
    workers: [
      [samples.slow, null],
      [samples.fast, samples.fast],
    ],
  });
  assert.equal(result.normal.workers[0].fps.p50, 30);
  assert.ok(verdict.violations.some((v) => v.rule === 'fps-p50'));
});
test('reordered retry snapshots retain originating worker identity', async () => {
  const { result, verdict } = await measure({
    workers: [
      [samples.slow, samples.slow],
      [samples.fast, samples.fast],
    ],
    reverseRetry: true,
  });
  assert.equal(result.normal.workers[0].fps.p50, 30);
  assert.ok(verdict.violations.some((v) => v.rule === 'fps-p50'));
});
test('missing first worker does not shift another worker onto its retry', async () => {
  const { result, verdict } = await measure({
    workers: [
      [null, samples.fast],
      [samples.slow, samples.slow],
    ],
  });
  assert.equal(result.normal.workers[0].fps.p50, 30);
  assert.ok(verdict.violations.some((v) => v.rule === 'fps-p50'));
});
test('two slow windows still fail unchanged p50 budget', async () => {
  assert.ok(
    (await measure({ workers: [[samples.slow, samples.slow]] })).verdict.violations.some(
      (v) => v.rule === 'fps-p50'
    )
  );
});
test('two slow windows while other processes held the host are inconclusive, not failures', async () => {
  // Counters around window 1 and window 2: others use 85% then 90% of the host's CPU.
  const contended = [
    { busy: 0, total: 0, own: 0 },
    { busy: 950, total: 1000, own: 100 },
    { busy: 950, total: 1000, own: 100 },
    { busy: 1900, total: 2000, own: 150 },
  ];
  const { result, verdict } = await measure({
    workers: [[samples.slow, samples.slow]],
    hostCpu: contended,
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify((result.normal as unknown as { hostCpu: unknown }).hostCpu)),
    [
      { other: 0.85, own: 0.1, idle: 0.05 },
      { other: 0.9, own: 0.05, idle: 0.05 },
    ],
    'one measured share per fps window'
  );
  assert.ok(!verdict.violations.some((v) => v.rule.startsWith('fps')), JSON.stringify(verdict));
  assert.ok(verdict.warnings.some((w) => w.rule === 'fps-inconclusive'));
  // The same windows with a quiet host for the retry are judged.
  const quietRetry = [
    ...contended.slice(0, 2),
    contended[1],
    { busy: 1100, total: 2000, own: 150 },
  ];
  assert.ok(
    (
      await measure({ workers: [[samples.slow, samples.slow]], hostCpu: quietRetry })
    ).verdict.violations.some((v) => v.rule === 'fps-p50')
  );
});
test('retry cannot erase first-window long-task failure', async () => {
  assert.ok(
    (await measure({ longTask: true })).verdict.violations.some((v) => v.rule === 'long-task')
  );
});
for (const worker of [true, false]) {
  test(`${worker ? 'worker' : 'main'} exactly ten frames remain eligible`, async () => {
    const eligible = samples.fast.slice(1, 11);
    const { verdict } = await measure(
      worker
        ? { workers: [[samples.slow, eligible]] }
        : { main: [samples.slow, eligible], workers: [] }
    );
    assert.deepEqual(Array.from(verdict.violations), []);
  });
  test(`${worker ? 'worker' : 'main'} nonfinite retry retains measured failure`, async () => {
    const invalid = Array.from({ length: 20 }, () => Number.NaN);
    const { verdict } = await measure(
      worker
        ? { workers: [[samples.slow, invalid]] }
        : { main: [samples.slow, invalid], workers: [] }
    );
    assert.ok(verdict.violations.some((v) => v.rule === 'fps-p50'));
  });
}
