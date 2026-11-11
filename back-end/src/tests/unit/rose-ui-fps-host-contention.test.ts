#!/usr/bin/env tsx
/**
 * `rose-ui check` judges fps only on windows where the page had the host's CPU:
 *
 *   hostCpuSample (/proc/stat + this check's process tree) ──before/after each fps window──►
 *   hostCpuShare {other, own, idle} ──► normal.hostCpu[] ──► evaluateBudgets
 *     every window other > 0.5 ──► missed fps = fps-inconclusive warning (other rules still judged)
 *     any quieter window        ──► missed fps = fps-p50 / fps-p5 violation
 *
 * The 1-minute load average lags a host that just became busy (the new-test stability gate
 * starts its load beside the check), so measured in-window contention is what tells host
 * starvation from page jank. Without a browser; rose-ui-cli-browser.test.ts runs the real check.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { userUiAssetsDir } from '../../providers/userUi/seed';

interface Verdict {
  pass: boolean;
  violations: { rule: string; message: string }[];
  warnings: { rule: string; message: string }[];
}
interface CpuSample {
  busy: number;
  total: number;
  own: number;
}
interface Cli {
  evaluateBudgets(result: unknown): Verdict;
  frameStats(times: number[]): { frames: number; p50: number | null; p5: number | null };
  hostCpuSample(rootPid?: number, proc?: string): CpuSample | null;
  hostCpuShare(
    before: CpuSample | null,
    after: CpuSample | null
  ): { other: number; own: number; idle: number } | null;
}

const cli = createRequire(__filename)(join(userUiAssetsDir(), 'bin', 'rose-ui.cjs')) as Cli;
const rules = (v: Verdict) => v.violations.map((x) => x.rule).sort();

const smoothFrames = Array.from({ length: 120 }, (_, i) => i * 16.67);
const SMOOTH = {
  static: { violations: [], warnings: [] },
  normal: {
    fps: cli.frameStats(smoothFrames),
    workers: [{ fps: cli.frameStats(smoothFrames) }],
    longTasks: [],
    cls: 0,
    errors: [],
    animations: [],
    bytes: { total: 40_000 },
  },
  hidden: { callbacksPerSec: 0, workers: [{ callbacksPerSec: 0 }] },
  reducedMotion: { changedFraction: 0 },
};
/** A 30 fps worker (the particles-worker failure's shape) plus jank no host noise excuses. */
const JANKY = {
  static: { violations: [], warnings: [] },
  normal: {
    ...SMOOTH.normal,
    workers: [{ fps: cli.frameStats(Array.from({ length: 60 }, (_, i) => i * 33.33)) }],
    longTasks: [{ phase: 'steady', duration: 84, cpu: 83 }],
    animations: [{ name: 'slide', properties: ['left'] }],
  },
  hidden: { callbacksPerSec: 60, workers: [{ callbacksPerSec: 0 }] },
  reducedMotion: { changedFraction: 0.02 },
};

test('fps is not judged when other processes held the host CPU in every measured window', () => {
  // The stability gate's shape: the 1-minute load average still reads under the busy limit
  // (it lags a host that just became busy) while busy loops hold most of every CPU.
  const contended = [
    { other: 0.86, own: 0.13, idle: 0.01 },
    { other: 0.88, own: 0.12, idle: 0 },
  ];
  const busy = cli.evaluateBudgets({
    ...JANKY,
    host: { loadPerCore: 0.9 },
    normal: { ...JANKY.normal, hostCpu: contended },
  });
  assert.ok(
    !rules(busy).some((r) => r.startsWith('fps')),
    'fps not judged under measured contention'
  );
  const note = busy.warnings.find((w) => w.rule === 'fps-inconclusive');
  assert.ok(note && /other processes used 86% and 88%/.test(note.message), JSON.stringify(note));
  for (const rule of ['long-task', 'hidden-loop', 'reduced-motion', 'layout-animation']) {
    assert.ok(rules(busy).includes(rule), `${rule} still enforced under contention`);
  }
  // Real jank is still judged when any window it could be judged on had the host to itself.
  for (const hostCpu of [
    [
      { other: 0.86, own: 0.13, idle: 0.01 },
      { other: 0.02, own: 0.2, idle: 0.78 },
    ],
    [{ other: 0.5, own: 0.2, idle: 0.3 }],
    [null],
    [],
  ]) {
    const judged = cli.evaluateBudgets({
      ...JANKY,
      host: { loadPerCore: 0.9 },
      normal: { ...JANKY.normal, hostCpu },
    });
    assert.ok(rules(judged).includes('fps-p50'), `judged with ${JSON.stringify(hostCpu)}`);
    assert.ok(!judged.warnings.some((w) => w.rule === 'fps-inconclusive'));
  }
  const smooth = cli.evaluateBudgets({
    ...SMOOTH,
    normal: { ...SMOOTH.normal, hostCpu: contended },
  });
  assert.equal(smooth.pass, true);
  assert.ok(!smooth.warnings.some((w) => w.rule === 'fps-inconclusive'), 'met fps needs no excuse');
});

test("host CPU shares attribute this check's process tree (with reaped children) apart from other load", () => {
  const proc = mkdtempSync(join(tmpdir(), 'rose-ui-cpu-'));
  // /proc/stat cpu: user nice system idle iowait irq softirq steal.
  const write = (stat: number[], procs: Record<number, [number, number[]]>) => {
    writeFileSync(join(proc, 'stat'), `cpu  ${stat.join(' ')} 0 0\ncpu0 1 2 3\n`);
    for (const [pid, [ppid, [utime, stime, cutime, cstime]]] of Object.entries(procs)) {
      mkdirSync(join(proc, pid), { recursive: true });
      const rest = Array.from({ length: 9 }, () => '0').join(' ');
      writeFileSync(
        join(proc, pid, 'stat'),
        `${pid} (chrome (x) y) S ${ppid} ${rest} ${utime} ${stime} ${cutime} ${cstime} 20 0\n`
      );
    }
  };
  try {
    // 10 = this CLI, 20 its Chromium (name with spaces and parens), 30 a renderer, 99 a busy loop.
    write([1000, 0, 0, 1000, 0, 0, 0, 0], {
      10: [1, [10, 0, 0, 0]],
      20: [10, [40, 0, 0, 0]],
      30: [20, [50, 0, 0, 0]],
      99: [1, [900, 0, 0, 0]],
    });
    const before = cli.hostCpuSample(10, proc);
    assert.deepEqual(before, { busy: 1000, total: 2000, own: 100 });
    // 1000 ticks pass: the busy loop takes 700, the check 200; the renderer exits and is
    // reaped by Chromium (its 80 ticks move into 20's cutime), so the tree keeps them.
    rmSync(join(proc, '30'), { recursive: true });
    write([1900, 0, 0, 1100, 0, 0, 0, 0], {
      10: [1, [30, 0, 0, 0]],
      20: [10, [130, 10, 130, 0]],
      99: [1, [1600, 0, 0, 0]],
    });
    const after = cli.hostCpuSample(10, proc);
    assert.deepEqual(after, { busy: 1900, total: 3000, own: 300 });
    assert.deepEqual(cli.hostCpuShare(before, after), { other: 0.7, own: 0.2, idle: 0.1 });
    assert.equal(cli.hostCpuShare(null, after), null, 'no /proc: no share');
    assert.equal(cli.hostCpuShare(after, after), null, 'no elapsed ticks: no share');
    assert.equal(cli.hostCpuSample(10, join(proc, 'missing')), null);
    // Fail closed: never a share that would count the page's own CPU as other load.
    assert.equal(cli.hostCpuSample(4242, proc), null, 'this process absent from /proc: no sample');
    assert.equal(
      cli.hostCpuShare(after, {
        ...after,
        busy: after.busy + 900,
        total: after.total + 1000,
        own: 0,
      }),
      null,
      'own CPU went backwards (a tree process reaped outside the tree): no share'
    );
  } finally {
    rmSync(proc, { recursive: true, force: true });
  }
});
