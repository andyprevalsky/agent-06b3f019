#!/usr/bin/env tsx
/**
 * Structural test (C16): every sized code-agent template comes from ONE source.
 *
 *   e2b-templates/sized-templates.json ──► build-sized-templates.mjs --json (the real build plan)
 *     ├─ grid == DEFAULT_SANDBOX_GRID (backend) and ≤ MAX_GRID_POINTS per provider
 *     ├─ each provider: every size uses the same source dir and the same Dockerfile,
 *     │    differing only in cpu / memory; names == sizedTemplateName(provider, size)
 *     └─ no per-size copies are committed (extra e2b*.toml / *.Dockerfile under e2b-templates)
 *
 * Run: npx tsx src/tests/structural/sandbox-size-templates.test.ts
 */
import assert from 'assert';
import { execFileSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import {
  DEFAULT_SANDBOX_GRID,
  MAX_GRID_POINTS,
  sizedTemplateName,
  type SandboxProvider,
} from '../../providers/codeSessions/sandboxSize';

const repoRoot = path.resolve(__dirname, '../../../..');
const templatesDir = path.join(repoRoot, 'e2b-templates');

interface PlanEntry {
  provider: SandboxProvider;
  name: string;
  cpu: number;
  memoryGb: number;
  source: string;
  dockerfile: string;
}

const config = JSON.parse(readFileSync(path.join(templatesDir, 'sized-templates.json'), 'utf8')) as {
  grid: { cpu: number[]; memoryGb: number[] };
  maxGridPoints: number;
  providers: Record<string, { source: string; dockerfile: string }>;
};
const plan = JSON.parse(
  execFileSync(process.execPath, [path.join(templatesDir, 'build-sized-templates.mjs'), '--json'], {
    encoding: 'utf8',
  })
) as PlanEntry[];

let checks = 0;
function check(name: string, fn: () => void): void {
  checks += 1;
  fn();
  console.log(`  PASS ${name}`);
}

check('grid matches the backend default grid and the size limit', () => {
  assert.deepStrictEqual(config.grid, DEFAULT_SANDBOX_GRID);
  assert.strictEqual(config.maxGridPoints, MAX_GRID_POINTS);
  assert.ok(config.grid.cpu.length * config.grid.memoryGb.length <= MAX_GRID_POINTS);
});

check('the build plan covers every provider × size exactly once', () => {
  const providers = Object.keys(config.providers).sort();
  assert.deepStrictEqual(providers, ['claude', 'codex']);
  const sizes = config.grid.cpu.length * config.grid.memoryGb.length;
  assert.strictEqual(plan.length, providers.length * sizes);
  assert.strictEqual(new Set(plan.map((entry) => entry.name)).size, plan.length);
});

check('every size of a provider is built from one source and one Dockerfile', () => {
  for (const [provider, spec] of Object.entries(config.providers)) {
    const entries = plan.filter((entry) => entry.provider === provider);
    assert.ok(entries.length > 0, provider);
    for (const entry of entries) {
      assert.strictEqual(entry.source, spec.source, entry.name);
      assert.strictEqual(entry.dockerfile, spec.dockerfile, entry.name);
      assert.strictEqual(
        entry.name,
        sizedTemplateName(provider as SandboxProvider, { cpu: entry.cpu, memoryGb: entry.memoryGb })
      );
    }
    const dockerfile = path.join(templatesDir, spec.source, spec.dockerfile);
    assert.ok(statSync(dockerfile).isFile(), `${dockerfile} exists`);
  }
});

check('no per-size template copies are committed', () => {
  for (const spec of Object.values(config.providers)) {
    const files = readdirSync(path.join(templatesDir, spec.source));
    const tomls = files.filter((file) => /^e2b.*\.toml$/.test(file));
    const dockerfiles = files.filter((file) => /Dockerfile/.test(file));
    assert.deepStrictEqual(tomls, ['e2b.toml'], `${spec.source}: ${tomls.join(', ')}`);
    assert.deepStrictEqual(dockerfiles, [spec.dockerfile], `${spec.source}: ${dockerfiles.join(', ')}`);
  }
});

console.log(`\nsandbox-size-templates: ${checks} checks passed`);
