#!/usr/bin/env tsx
/**
 * Executable smoke for the `rose-ui` CLI in a real headless Chromium (the same
 * commands a code agent runs in its session):
 *
 *   fixtures/user-ui/smoke ──► rose-ui screenshot ──► PNG: non-blank, theme pixel probe
 *                          ──► rose-ui screenshot ?safe=1 ──► probe absent (negative control)
 *                          ──► rose-ui perf ──► metrics JSON (fps, long tasks, CLS, bytes, props bridge)
 *                          ──► rose-ui record ──► frame strip PNG (+ MP4 when ffmpeg is installed)
 *   fixtures/user-ui/janky ──► rose-ui check ──► exit 1 on the load-independent rules
 *   assets/user-ui/seed    ──► rose-ui check --examples ──► exit 0, every example passes
 *
 * Fixtures are copied to a temp folder so captures never land in the repo; the CLI
 * runs in place so coverage maps to its source. Set ROSE_UI_SMOKE_OUT to keep outputs.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { userUiAssetsDir, USER_UI_SEED_EXAMPLES } from '../../providers/userUi/seed';

const assets = userUiAssetsDir();
const cliPath = join(assets, 'bin', 'rose-ui.cjs');
const localRequire = createRequire(__filename);
const cli = localRequire(cliPath) as {
  decodePng(buf: Buffer): { width: number; height: number; channels: number; data: Buffer };
  pngStats(img: unknown): { nonBlank: boolean };
};
const playwrightCore = dirname(localRequire.resolve('playwright-core/package.json'));
const fixtures = join(__dirname, '..', 'fixtures', 'user-ui');
const out = process.env.ROSE_UI_SMOKE_OUT || mkdtempSync(join(tmpdir(), 'rose-ui-smoke-'));
mkdirSync(out, { recursive: true });

function folder(name: string, source: string): string {
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(source, dir, { recursive: true });
  return dir;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function rose(dir: string, args: string[], timeoutMs = 240_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          ROSE_UI_DIR: dir,
          ROSE_UI_PLAYWRIGHT_CORE: playwrightCore,
          ROSE_UI_PUBLISHED_BASE_URL: '',
        },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function json<T>(run: Run, label: string): T {
  try {
    return JSON.parse(run.stdout) as T;
  } catch {
    throw new Error(
      `${label}: exit ${run.code}, not JSON:\n${run.stdout.slice(0, 800)}\n${run.stderr.slice(0, 800)}`
    );
  }
}

/** Fraction of pixels within `tol` of an RGB colour. */
function colorFraction(file: string, rgb: number[], tol = 14): number {
  const img = cli.decodePng(readFileSync(file));
  let hits = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * img.channels;
    if (rgb.every((c, k) => Math.abs(img.data[o + k] - c) <= tol)) hits++;
  }
  return hits / (img.width * img.height);
}

// theme.json in the smoke fixture: --primary 330 90% 50%, --background 200 60% 92%.
const PRIMARY = [242, 13, 128];
const BACKGROUND = [222, 239, 247];
const smoke = folder('smoke', join(fixtures, 'smoke'));

test('screenshot renders the local UI with its theme (pixel probe + safe-mode control)', async () => {
  const file = join(out, 'home.png');
  const run = await rose(smoke, ['screenshot', '--json', '--out', file]);
  const shot = json<{
    path: string;
    stats: { width: number; height: number; nonBlank: boolean };
    frames: { kind: string; name: string; loaded: boolean; ready: boolean }[];
  }>(run, 'screenshot');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(shot.path, file);
  assert.deepEqual([shot.stats.width, shot.stats.height], [2880, 1800], 'default 1440x900 at 2x');
  assert.equal(shot.stats.nonBlank, true);
  assert.deepEqual(
    shot.frames.map((f) => [f.kind, f.name, f.loaded, f.ready]),
    [['slot', 'home.dashboard', true, true]]
  );
  assert.ok(colorFraction(file, PRIMARY) > 0.0005, 'theme --primary visible (composer button)');
  assert.ok(colorFraction(file, BACKGROUND) > 0.3, 'theme --background visible');
  process.stdout.write(`# screenshot: ${file}\n`);

  const safe = join(out, 'home-safe.png');
  const safeRun = await rose(smoke, [
    'screenshot',
    '--route',
    '/?safe=1',
    '--viewport',
    '800x600',
    '--scale',
    '1',
    '--out',
    safe,
  ]);
  assert.equal(safeRun.code, 0, safeRun.stderr);
  assert.equal(colorFraction(safe, PRIMARY), 0, 'safe mode renders without the user theme');
  assert.ok(colorFraction(safe, BACKGROUND) < 0.01, 'safe mode keeps the stock background');
});

test('perf reports metrics for an entry and the bridge delivers example props', async () => {
  const run = await rose(smoke, [
    'perf',
    '--entry',
    'inline/hello/index.html',
    '--seconds',
    '2',
    '--full',
  ]);
  assert.equal(run.code, 0, run.stderr);
  const perf = json<{
    normal: {
      fps: { frames: number; p50: number };
      longTasks: unknown[];
      cls: number;
      bytes: { total: number; requests: number };
      gpuMemoryEstimateBytes: number;
      errors: string[];
      dataset: Record<string, string>;
    };
    hidden: { callbacksPerSec: number };
    reducedMotion: { changedFraction: number };
    host: { cpus: number };
  }>(run, 'perf');
  assert.ok(
    perf.normal.fps.frames >= 10 && perf.normal.fps.p50 > 0,
    JSON.stringify(perf.normal.fps)
  );
  assert.ok(Array.isArray(perf.normal.longTasks));
  assert.equal(typeof perf.normal.cls, 'number');
  assert.ok(
    perf.normal.bytes.total > 0 && perf.normal.bytes.requests >= 1,
    JSON.stringify(perf.normal.bytes)
  );
  assert.equal(typeof perf.normal.gpuMemoryEstimateBytes, 'number');
  assert.deepEqual(perf.normal.errors, []);
  assert.equal(
    perf.normal.dataset.props,
    '{"name":"smoke"}',
    'props.example.json reached the view via rose:props'
  );
  assert.equal(perf.hidden.callbacksPerSec, 0);
  assert.equal(perf.reducedMotion.changedFraction, 0);
  assert.ok(perf.host.cpus >= 1);
});

test('record writes a frame strip (and an MP4 when ffmpeg exists)', async () => {
  const video = join(out, 'record.mp4');
  const run = await rose(smoke, [
    'record',
    '--seconds',
    '1',
    '--viewport',
    '640x400',
    '--out',
    video,
    '--json',
  ]);
  assert.equal(run.code, 0, run.stderr);
  const rec = json<{ video: string | null; strip: string; capturedFrames: number }>(run, 'record');
  assert.ok(rec.capturedFrames >= 1);
  assert.equal(
    cli.pngStats(cli.decodePng(readFileSync(rec.strip))).nonBlank,
    true,
    'strip has content'
  );
  if (rec.video)
    assert.equal(readFileSync(rec.video).subarray(4, 8).toString('ascii'), 'ftyp', 'MP4 container');
});

test('check fails the deliberately janky fixture on load-independent rules', async () => {
  const janky = folder('janky', join(fixtures, 'janky'));
  const run = await rose(janky, ['check', '--json']);
  assert.equal(run.code, 1, 'check exits 1 on violations');
  const report = json<{
    pass: boolean;
    entries: { verdict: { violations: { rule: string }[] } }[];
  }>(run, 'check janky');
  assert.equal(report.pass, false);
  const rules = new Set(report.entries[0].verdict.violations.map((v) => v.rule));
  for (const rule of [
    'long-task',
    'layout-animation',
    'hidden-loop',
    'reduced-motion',
    'reduced-motion-static',
  ]) {
    assert.ok(rules.has(rule), `janky fixture violates ${rule} (got ${[...rules].join(', ')})`);
  }
});

test('check --examples passes every shipped example', async () => {
  const seed = folder('seed', join(assets, 'seed'));
  const run = await rose(seed, [
    'check',
    '--examples',
    '--json',
    '--out',
    join(out, 'examples-check.json'),
  ]);
  const report = json<{
    pass: boolean;
    entries: {
      name: string;
      verdict: { pass: boolean; violations: unknown[]; warnings: { rule: string }[] };
    }[];
  }>(run, 'check examples');
  const failing = report.entries
    .filter((e) => !e.verdict.pass)
    .map((e) => `${e.name}: ${JSON.stringify(e.verdict.violations)}`);
  assert.deepEqual(failing, []);
  assert.equal(run.code, 0);
  assert.deepEqual(report.entries.map((e) => e.name).sort(), [...USER_UI_SEED_EXAMPLES].sort());
  for (const e of report.entries) {
    const notes = e.verdict.warnings.map((w) => w.rule);
    if (notes.length) process.stdout.write(`# ${e.name}: warnings ${notes.join(', ')}\n`);
  }
});

test.after(() => {
  if (!process.env.ROSE_UI_SMOKE_OUT && existsSync(out))
    rmSync(out, { recursive: true, force: true });
});
