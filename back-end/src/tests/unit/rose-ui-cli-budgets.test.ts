#!/usr/bin/env tsx
/**
 * `rose-ui check` budget logic, without a browser:
 *   - evaluateBudgets fails a janky measurement on every rule and passes a smooth one;
 *     host noise turns missed fps into warnings but never hides other violations
 *   - static audits pass every shipped example and fail the janky fixture
 *   - CLS session windows, frame stats, theme lint, PNG decode/diff, publish paths
 *   - the CLI's preview CSP is byte-identical to the usercontent CSP
 * The browser half lives in rose-ui-cli-browser.test.ts.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { USERCONTENT_CSP } from '../../domains/user-ui/config';
import { buildCodeAgentSystemPrompt } from '../../providers/codeAgentPrompt';
import { installedRoseSkills } from '../../providers/roseSkills/skills';
import { userUiAssetsDir, userUiExamplesDir, USER_UI_EXAMPLES } from '../../providers/userUi/seed';

interface Violation {
  rule: string;
  message: string;
}
interface Verdict {
  pass: boolean;
  violations: Violation[];
  warnings: Violation[];
}
interface AuditFile {
  path: string;
  size: number;
  text?: string;
}
interface Png {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}
interface Cli {
  USERCONTENT_CSP: string;
  DEFAULT_BUDGETS: Record<string, number>;
  evaluateBudgets(result: unknown): Verdict;
  traceMainThreadTasks(
    trace: Buffer,
    minMs: number
  ): { phase: string; duration: number; cpu: number }[];
  auditEntryFiles(
    entry: string,
    files: AuditFile[]
  ): { violations: Violation[]; warnings: Violation[] };
  frameStats(times: number[]): { frames: number; p50: number | null; p5: number | null };
  cumulativeLayoutShift(shifts: { t: number; v: number }[]): number;
  lintTheme(theme: unknown): Violation[];
  isPublishablePath(path: string): boolean;
  parseArgs(argv: string[]): Record<string, unknown>;
  parseViewport(value: unknown, fallback: unknown): { width: number; height: number };
  routeSlug(route: string): string;
  decodePng(buf: Buffer): Png;
  pngStats(img: Png): { nonBlank: boolean; distinctColors: number };
  diffFraction(a: Png, b: Png): number;
}

const assets = userUiAssetsDir();
// The CLI is a CommonJS asset installed into sandboxes; it exports its pure logic.
const cli = createRequire(__filename)(join(assets, 'bin', 'rose-ui.cjs')) as Cli;
const rules = (v: Verdict) => v.violations.map((x) => x.rule).sort();

const smoothFrames = Array.from({ length: 120 }, (_, i) => i * 16.67);
const SMOOTH = {
  static: { violations: [], warnings: [] },
  normal: {
    fps: cli.frameStats(smoothFrames),
    workers: [{ fps: cli.frameStats(smoothFrames) }],
    longTasks: [{ phase: 'load', duration: 120 }],
    cls: 0.01,
    errors: [],
    animations: [{ name: 'fade', properties: ['opacity', 'transform'] }],
    bytes: { total: 40_000 },
  },
  hidden: { callbacksPerSec: 0, workers: [{ callbacksPerSec: 0 }] },
  reducedMotion: { changedFraction: 0 },
};

/** Every 6th frame takes 100 ms: the deliberately janky fixture's shape. */
const jankyFrames: number[] = [];
for (let i = 0, t = 0; i < 120; i++) jankyFrames.push((t += i % 6 === 0 ? 100 : 16.67));
const JANKY = {
  static: { violations: [{ rule: 'reduced-motion-static', message: 'x' }], warnings: [] },
  normal: {
    fps: cli.frameStats(jankyFrames),
    workers: [{ fps: cli.frameStats(Array.from({ length: 40 }, (_, i) => i * 50)) }],
    longTasks: [{ phase: 'steady', duration: 84, cpu: 83 }],
    cls: 0.31,
    errors: ['ReferenceError: x is not defined'],
    animations: [{ name: 'slide', properties: ['left', 'width'] }],
    bytes: { total: 6 * 1024 * 1024 },
  },
  hidden: { callbacksPerSec: 60, workers: [{ callbacksPerSec: 120 }] },
  reducedMotion: { changedFraction: 0.02 },
};

test('janky measurement fails every rule; smooth one passes', () => {
  // Main thread: median frame is fine (p50 ~60) but p5 is 10 fps; worker: 20 fps throughout.
  assert.deepEqual(rules(cli.evaluateBudgets(JANKY)), [
    'fps-p5',
    'fps-p5',
    'fps-p50',
    'hidden-loop',
    'hidden-loop',
    'layout-animation',
    'layout-shift',
    'long-task',
    'page-error',
    'reduced-motion',
    'reduced-motion-static',
    'runtime-bytes',
  ]);
  const smooth = cli.evaluateBudgets(SMOOTH);
  assert.equal(smooth.pass, true, JSON.stringify(smooth.violations));
  assert.deepEqual(
    smooth.warnings.map((w) => w.rule),
    ['load-long-task'],
    'a long task during load is a warning, not a failure'
  );
});

test('host noise makes missed fps inconclusive but keeps every other violation', () => {
  for (const host of [{ host: { loadPerCore: 3.1 } }, { hostBaseline: { p50: 30, p5: 20 } }]) {
    const verdict = cli.evaluateBudgets({ ...JANKY, ...host });
    assert.ok(!rules(verdict).some((r) => r.startsWith('fps')), 'fps not judged on a noisy host');
    assert.ok(verdict.warnings.some((w) => w.rule === 'fps-inconclusive'));
    for (const rule of ['long-task', 'hidden-loop', 'reduced-motion', 'layout-animation']) {
      assert.ok(rules(verdict).includes(rule), `${rule} still enforced on a noisy host`);
    }
  }
  const quietPass = cli.evaluateBudgets({ ...SMOOTH, host: { loadPerCore: 3.1 } });
  assert.equal(quietPass.warnings.filter((w) => w.rule === 'fps-inconclusive').length, 0);
});

test('long-task: CPU-heavy tasks fail; wall-only tasks fail unless a second window is clean', () => {
  const withTasks = (normal: Record<string, unknown>) =>
    cli.evaluateBudgets({ ...SMOOTH, normal: { ...SMOOTH.normal, ...normal } });
  // A 134 ms wall-clock task that used 2 ms of CPU and did not recur: the host stalled the renderer.
  const stalled = withTasks({
    longTasks: [{ phase: 'steady', duration: 134, cpu: 2 }],
    longTaskRecheck: [],
  });
  assert.equal(stalled.pass, true, JSON.stringify(stalled.violations));
  assert.ok(stalled.warnings.some((w) => w.rule === 'long-task-stall'));
  // A blocking wait the page repeats (GPU readback, sync XHR, a busy-wait on a loaded host) recurs.
  const recurring = withTasks({
    longTasks: [{ phase: 'steady', duration: 84, cpu: 30 }],
    longTaskRecheck: [{ phase: 'steady', duration: 82, cpu: 28 }],
  });
  assert.deepEqual(rules(recurring), ['long-task']);
  // Not re-measured, or no CPU time recorded: judged on wall time.
  assert.deepEqual(rules(withTasks({ longTasks: [{ phase: 'steady', duration: 134, cpu: 2 }] })), [
    'long-task',
  ]);
  assert.deepEqual(rules(withTasks({ longTasks: [{ phase: 'steady', duration: 134 }] })), [
    'long-task',
  ]);
  // The same wall time spent computing is the page's own work, whatever the second window shows.
  const busy = withTasks({
    longTasks: [{ phase: 'steady', duration: 134, cpu: 131 }],
    longTaskRecheck: [],
  });
  assert.deepEqual(rules(busy), ['long-task']);

  // Steady tasks come from a Chromium trace: renderer main-thread RunTask events with tdur.
  const trace = Buffer.from(
    JSON.stringify({
      traceEvents: [
        { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'CrRendererMain' } },
        { ph: 'M', name: 'thread_name', pid: 1, tid: 2, args: { name: 'Compositor' } },
        { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 1, dur: 3000, tdur: 2900 },
        { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 1, dur: 134000, tdur: 1800 },
        { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 1, dur: 81000, tdur: 80500 },
        { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 2, dur: 90000, tdur: 90000 },
      ],
    })
  );
  assert.deepEqual(cli.traceMainThreadTasks(trace, 50), [
    { phase: 'steady', duration: 134, cpu: 1.8 },
    { phase: 'steady', duration: 81, cpu: 80.5 },
  ]);
  const noCpu = Buffer.from(
    JSON.stringify({
      traceEvents: [
        { ph: 'M', name: 'thread_name', pid: 1, tid: 1, args: { name: 'CrRendererMain' } },
        { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 1, dur: 90000 },
      ],
    })
  );
  assert.throws(() => cli.traceMainThreadTasks(noCpu, 50), /no thread CPU time/);
});

test('frame stats and CLS session windows', () => {
  const fps = cli.frameStats(smoothFrames);
  assert.ok(fps.p50! > 59 && fps.p50! < 61 && fps.p5! > 59, JSON.stringify(fps));
  assert.equal(cli.frameStats([1, 2]).p50, null, 'too few frames is not a measurement');
  const janky = cli.frameStats(jankyFrames);
  assert.ok(janky.p50! > 55 && janky.p5! <= 10, JSON.stringify(janky));
  // Two bursts 3 s apart are separate windows: CLS is the larger one, not the sum.
  const shifts = [
    { t: 100, v: 0.04 },
    { t: 400, v: 0.03 },
    { t: 3400, v: 0.05 },
  ];
  assert.equal(Number(cli.cumulativeLayoutShift(shifts).toFixed(3)), 0.07);
  // Continuous shifting is capped at a 5 s window.
  const steady = Array.from({ length: 20 }, (_, i) => ({ t: i * 500, v: 0.01 }));
  assert.equal(Number(cli.cumulativeLayoutShift(steady).toFixed(3)), 0.11);
  assert.equal(cli.cumulativeLayoutShift([]), 0);
});

/** 60 Hz frames where `share` of them miss `missed` vsyncs, with ±0.1 ms timestamp jitter. */
function vsyncFrames(share: number, missed: number, jitter: number): number[] {
  const times = [0];
  for (let i = 1; i < 200; i++) {
    const late = i % Math.round(1 / share) === 0;
    times.push(times[i - 1] + (late ? (missed + 1) * 16.667 : 16.667) + (i % 2 ? jitter : -jitter));
  }
  return times;
}

test('frame stats are quantized to the refresh interval (timestamp jitter cannot flip a verdict)', () => {
  // Regression: one missed vsync at p95 measured as 33.4 ms → "29.9 fps" and failed
  // fps-p5 (min 30), while the identical cadence at 33.3 ms passed.
  for (const jitter of [0.1, -0.1, 0.4]) {
    const oneMissed = cli.frameStats(vsyncFrames(1 / 8, 1, jitter));
    assert.equal(oneMissed.p5, 30, `one missed vsync at p95 is 30 fps (jitter ${jitter})`);
    assert.equal(oneMissed.p50, 60);
    const verdict = cli.evaluateBudgets({
      ...SMOOTH,
      normal: { ...SMOOTH.normal, workers: [{ fps: oneMissed }] },
    });
    assert.equal(verdict.pass, true, JSON.stringify(verdict.violations));
  }
  // Two missed vsyncs at p95 is real jank and still fails.
  const twoMissed = cli.frameStats(vsyncFrames(1 / 8, 2, 0.1));
  assert.equal(twoMissed.p5, 20);
  const verdict = cli.evaluateBudgets({
    ...SMOOTH,
    normal: { ...SMOOTH.normal, workers: [{ fps: twoMissed }] },
  });
  assert.deepEqual(rules(verdict), ['fps-p5']);
});

function auditFiles(root: string): AuditFile[] {
  const out: AuditFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else {
        const rel = relative(root, abs).split('\\').join('/');
        const text = /\.(html?|js|css|json)$/.test(name) ? readFileSync(abs, 'utf8') : undefined;
        out.push({ path: rel, size: statSync(abs).size, text });
      }
    }
  };
  walk(root);
  return out;
}

test('static audit passes every shipped example and fails the janky fixture', () => {
  // The examples ship in the rose-ui skill (~/.rose/skills/rose-ui/examples).
  const skill = auditFiles(join(userUiExamplesDir(), '..'));
  for (const name of USER_UI_EXAMPLES) {
    const audit = cli.auditEntryFiles(`examples/${name}/index.html`, skill);
    assert.deepEqual(audit.violations, [], `${name}: ${JSON.stringify(audit.violations)}`);
    assert.deepEqual(audit.warnings, [], `${name}: ${JSON.stringify(audit.warnings)}`);
  }
  const janky = auditFiles(join(__dirname, '..', 'fixtures', 'user-ui', 'janky'));
  const audit = cli.auditEntryFiles('root/slots/janky/index.html', janky);
  assert.deepEqual(
    audit.violations.map((v) => v.rule),
    ['reduced-motion-static']
  );
  const heavy = cli.auditEntryFiles('root/x/index.html', [
    { path: 'root/x/index.html', size: 100, text: '<img src="a.gif">' },
    { path: 'root/x/a.gif', size: 900 * 1024 },
    { path: 'root/x/clip.mp4', size: 3 * 1024 * 1024 },
    { path: 'root/x/app.js', size: 2 * 1024 * 1024 },
  ]);
  assert.deepEqual(heavy.violations.map((v) => v.rule).sort(), [
    'bundle-bytes',
    'gif-bytes',
    'media-bytes',
    'script-bytes',
  ]);
  assert.deepEqual(
    heavy.warnings.map((w) => w.rule),
    ['img-size']
  );
});

test('theme lint matches how the app reads tokens', () => {
  assert.deepEqual(cli.lintTheme(null), []);
  assert.deepEqual(
    cli.lintTheme({ tokens: { '--primary': '262 83% 58%', '--radius': '14px' } }),
    []
  );
  const bad = cli.lintTheme({
    tokens: { '--primary': '#7c3aed', '--Bad': '1px', '--bg': 'url(x)' },
    background: { fadeAfterFirstMessage: 2 },
  });
  assert.deepEqual(
    bad.map((v) => v.rule),
    ['theme-token', 'theme-token', 'theme-token', 'theme-background']
  );
  assert.match(bad[0].message, /HSL triplet/);
});

/** Encode a tiny RGB PNG (filter 0) the way Chromium's writer would. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG decode, blank detection and pixel diff', () => {
  const blank = cli.decodePng(png(64, 64, () => [255, 255, 255]));
  assert.equal(blank.width, 64);
  assert.equal(cli.pngStats(blank).nonBlank, false);
  const art = cli.decodePng(png(64, 64, (x, y) => [x * 4, y * 4, (x * y) % 256]));
  assert.equal(cli.pngStats(art).nonBlank, true);
  assert.deepEqual([...art.data.subarray((10 * 64 + 5) * 3, (10 * 64 + 5) * 3 + 3)], [20, 40, 50]);
  assert.equal(cli.diffFraction(art, art), 0);
  const moved = cli.decodePng(
    png(64, 64, (x, y) => (x < 32 ? [x * 4, y * 4, (x * y) % 256] : [0, 0, 0]))
  );
  assert.ok(Math.abs(cli.diffFraction(art, moved) - 0.5) < 0.02);
});

test('args, routes and publishable paths', () => {
  assert.deepEqual(cli.parseArgs(['check', 'a.html', '--json', '--seconds', '3', '--out=r.json']), {
    _: ['check', 'a.html'],
    json: true,
    seconds: '3',
    out: 'r.json',
  });
  assert.deepEqual(cli.parseViewport('390x844', null), { width: 390, height: 844 });
  assert.throws(() => cli.parseViewport('big', null));
  assert.equal(cli.routeSlug('/'), 'home');
  assert.equal(
    cli.routeSlug('/file/examples/rose-os/index.html'),
    'file-examples-rose-os-index-html'
  );
  assert.equal(cli.isPublishablePath('examples/rose-os/index.html'), true);
  for (const p of [
    'screenshots/current/home.png',
    '.git/config',
    'a/node_modules/x.js',
    '../x',
    '/etc/passwd',
  ]) {
    assert.equal(cli.isPublishablePath(p), false, p);
  }
});

test('preview CSP is the production usercontent CSP', () => {
  assert.equal(cli.USERCONTENT_CSP, USERCONTENT_CSP);
  assert.match(USERCONTENT_CSP, /worker-src blob:/);
});

test('code agents are pointed at the rose-ui skill: pull, current screenshots and check', () => {
  // The Rose app UI is a Rose Desktop surface (utils/roseDesktop); the prompt
  // lists the rose-ui skill, which carries the commands (C17).
  const prompt = buildCodeAgentSystemPrompt({ roseDesktop: true });
  assert.ok(prompt.includes('\n- rose-ui: Use '), 'code-agent prompt lists the rose-ui skill');
  assert.ok(!buildCodeAgentSystemPrompt().includes('rose-ui'), 'stock prompt has no rose-ui');
  const skill = installedRoseSkills(true).find((entry) => entry.name === 'rose-ui');
  const text = skill?.files.find((file) => file.path === 'SKILL.md')?.content.toString('utf8');
  assert.ok(text, 'rose-ui skill installed for Rose Desktop accounts');
  for (const term of [
    'rose-ui pull [<dir>]',
    'rose-ui screenshot --current',
    'screenshots/current/',
    'rose-ui screenshot',
    'rose-ui check` must pass before `rose-ui publish',
    '~/.rose/skills/rose-ui/reference/bundle.md',
  ]) {
    assert.ok(text.includes(term), `rose-ui skill mentions ${term}`);
  }
  const paths = skill?.files.map((file) => file.path) ?? [];
  for (const name of USER_UI_EXAMPLES) {
    assert.ok(paths.includes(`examples/${name}/index.html`), `skill ships examples/${name}`);
  }
});
