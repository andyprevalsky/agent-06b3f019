/**
 * PJ4: `rose-sync seed-rose` gives the Rose project its checked-in startup and
 * sync scripts and its six declared env files. Registered by
 * project-workspace.blackbox.ts, which owns the fixture directory, the leak scan
 * list, the shared CLI runner and the fixture secret.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { anonymousSession, assert, call } from './projects-harness';

interface SeedRoseContext {
  fixture: string;
  repoRoot: string;
  secret: string;
  roseSync: string;
  baseUrl: string;
  leakTexts: Array<[string, string]>;
  sh: (cwd: string, cmd: string) => string;
  runChild: (
    file: string,
    args: string[],
    env?: NodeJS.ProcessEnv
  ) => Promise<{ status: number | null; stdout: string; stderr: string }>;
}

export function registerSeedRoseCase(ctx: SeedRoseContext): void {
  const {
    fixture,
    repoRoot: REPO_ROOT,
    secret: SECRET,
    roseSync: ROSE_SYNC,
    baseUrl: BASE_URL,
  } = ctx;
  const { leakTexts, sh, runChild } = ctx;
  test('seed-rose: Rose project gets its startup script and six env files (PJ4)', async () => {
    const s = await anonymousSession();
    const repo = join(fixture, 'rose-checkout');
    const fixtureScript = readFileSync(
      join(REPO_ROOT, 'agents/benchmarks/fixtures/projects/rose-startup.sh'),
      'utf8'
    );
    const outside = join(fixture, 'rose-outside');
    mkdirSync(outside, { recursive: true });
    sh(fixture, `git init -q -b main ${repo}`);
    mkdirSync(join(repo, 'agents/benchmarks/fixtures/projects'), { recursive: true });
    writeFileSync(join(repo, 'agents/benchmarks/fixtures/projects/rose-startup.sh'), fixtureScript);
    const syncScript = readFileSync(
      join(REPO_ROOT, 'agents/benchmarks/fixtures/projects/rose-sync.sh'),
      'utf8'
    );
    writeFileSync(join(repo, 'agents/benchmarks/fixtures/projects/rose-sync.sh'), syncScript);
    writeFileSync(join(repo, '.gitignore'), '.env\n.env.*\n');
    sh(repo, 'git -c user.name=t -c user.email=t@example.com add -A');
    sh(repo, 'git -c user.name=t -c user.email=t@example.com commit -qm init');
    // Andy's layout: env files are symlinks into a separate authoritative checkout.
    for (const rel of ['agents/.env', 'back-end/.env', 'agents/.env.benchmark-temporal']) {
      const real = join(outside, rel.replace(/\//g, '__'));
      writeFileSync(real, `SEEDED_${rel.replace(/[^A-Za-z]/g, '_').toUpperCase()}=${SECRET}\n`);
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      symlinkSync(real, join(repo, rel));
    }
    const out = await runChild(
      process.execPath,
      [ROSE_SYNC, 'seed-rose', '--dir', repo, '--json'],
      {
        ...process.env,
        ROSE_TOKEN: s.token,
        ROSE_API_URL: BASE_URL,
        ROSE_API_KEY: '',
      }
    );
    leakTexts.push(['seed-rose output', out.stdout + out.stderr]);
    assert(out.status === 0, `seed-rose failed: ${out.stderr}${out.stdout}`);
    const projects = await call('/api/projects', { auth: s.token });
    const rose = (projects.data.projects as Array<Record<string, unknown>>).find(
      (p) => p.name === 'Rose'
    );
    assert(rose, 'Rose project created');
    assert(rose.startupScript === fixtureScript, 'startup script is the checked-in fixture');
    const maintenance = rose.maintenance as { script: string; timeoutS: number };
    assert(maintenance.script === syncScript, 'sync script is the checked-in fixture');
    assert(maintenance.timeoutS === 480, `sync timeout ${maintenance.timeoutS}`);
    assert(rose.defaultBranch === 'main' && rose.startupTimeoutS === 900, 'Rose defaults');
    const files = await call(`/api/projects/${String(rose.id)}/env-files`, { auth: s.token });
    leakTexts.push(['Rose env-files response', files.text]);
    const byPath = new Map(
      (files.data.envFiles as Array<{ path: string; source: string; hasContent: boolean }>).map(
        (f) => [f.path, f]
      )
    );
    const expected = [
      'agents/.env',
      'back-end/.env',
      'agents/.env.benchmark-temporal',
      'front-end/.env',
      'mac-app/.env',
      'research/.env',
    ];
    assert(byPath.size === expected.length, `six env files, got ${[...byPath.keys()]}`);
    for (const path of expected.slice(0, 3)) {
      assert(byPath.get(path)?.source === 'sync' && byPath.get(path)?.hasContent, `${path} synced`);
    }
    for (const path of expected.slice(3)) {
      assert(byPath.get(path)?.source === 'declared', `${path} declared, awaiting sync`);
    }
  });
}
