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
  evaluateBudgets(result: unknown): { violations: { rule: string }[] };
}
const cliPath = resolve(__dirname, '../../assets/user-ui/bin/rose-ui.cjs');
const samples = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/user-ui/fps-windows.json'), 'utf8')
);
type Frames = number[] | null;

// Browser IO is replaced; actual measureWindow, workerCall, measureRoute and budgets run.
async function measure(options: {
  main?: number[][];
  workers?: Frames[][];
  reverseRetry?: boolean;
  longTask?: boolean;
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
  };
  runInNewContext(
    readFileSync(cliPath, 'utf8') +
      `
    openHost = async () => ({ page: {}, workers, context: { close: async () => {} }, bytes: { total: 0 } });
    userFrames = () => [frame];
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
