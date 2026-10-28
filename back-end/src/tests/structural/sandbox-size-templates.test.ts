#!/usr/bin/env tsx
/**
 * Structural test (C16): every sized code-agent template comes from ONE source.
 *
 *   e2b-templates/sized-templates.json ──► build-sized-templates.mjs --json (the real build plan)
 *     ├─ grid == DEFAULT_SANDBOX_GRID (backend) and ≤ MAX_GRID_POINTS per provider
 *     ├─ each provider: every size uses the same source dir and the same Dockerfile,
 *     │    differing only in cpu / memory; names == sizedTemplateName(provider, size)
 *     ├─ no per-size copies are committed (extra e2b*.toml / *.Dockerfile under e2b-templates)
 *     └─ --execute --via sdk (E2B_API_KEY, no CLI login), run against a stand-in e2b module:
 *          Template.build gets each plan entry's source dir, Dockerfile, name, cpu and memory;
 *          every size is booted and checked (nproc, MemTotal, provider CLI) and its sandbox
 *          killed; one wrong-sized template fails the run and withholds the grid go-ahead
 *
 * Run: npx tsx src/tests/structural/sandbox-size-templates.test.ts
 */
import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
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

const config = JSON.parse(
  readFileSync(path.join(templatesDir, 'sized-templates.json'), 'utf8')
) as {
  grid: { cpu: number[]; memoryGb: number[] };
  maxGridPoints: number;
  providers: Record<string, { source: string; dockerfile: string }>;
};
const buildScript = path.join(templatesDir, 'build-sized-templates.mjs');
const plan = JSON.parse(
  execFileSync(process.execPath, [buildScript, '--json'], {
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
    assert.deepStrictEqual(
      dockerfiles,
      [spec.dockerfile],
      `${spec.source}: ${dockerfiles.join(', ')}`
    );
  }
});

/**
 * Stand-in for the e2b SDK: records Template.build / Sandbox.create / kill calls and
 * boots "sandboxes" that report the size the template was built with
 * (FAKE_E2B_BAD_NPROC=<name> makes that one report 1 vCPU; FAKE_E2B_BUILD_FAIL=<name>
 * rejects that build the way E2B rejects a size over the team's memory limit).
 */
const FAKE_E2B_SDK = `
import { appendFileSync } from 'node:fs';
const record = (event) => appendFileSync(process.env.FAKE_E2B_LOG, JSON.stringify(event) + '\\n');
const built = new Map();
export function Template(options) {
  return {
    fromDockerfile: (dockerfile) => ({ fileContextPath: String(options.fileContextPath), dockerfile }),
  };
}
Template.build = async (template, name, options) => {
  record({ type: 'build', name, ...template, cpuCount: options.cpuCount, memoryMB: options.memoryMB });
  if (process.env.FAKE_E2B_BUILD_FAIL === name) {
    throw new Error("400: Memory can't be higher than 8192 MiB");
  }
  options.onBuildLogs({ toString: () => 'fake build log' });
  built.set(name, options);
  return { name, alias: name, tags: ['default'], templateId: 'tpl-' + name, buildId: 'build-' + name };
};
const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '' });
export const Sandbox = {
  async create(name) {
    const size = built.get(name);
    if (!size) throw new Error('template ' + name + ' not found');
    record({ type: 'create', name });
    const cli = name.startsWith('codex-code') ? 'codex' : 'claude';
    return {
      sandboxId: 'sbx-' + name,
      commands: {
        async run(cmd) {
          if (cmd === 'nproc') return ok(process.env.FAKE_E2B_BAD_NPROC === name ? '1' : String(size.cpuCount));
          if (cmd.includes('/proc/meminfo')) return ok('MemTotal: ' + Math.round(size.memoryMB * 1024 * 0.97) + ' kB');
          if (cmd === 'command -v ' + cli) return ok('/usr/bin/' + cli);
          if (cmd === cli + ' --version') return ok(cli + ' 1.0.0');
          if (cmd.includes('ws-server.mjs')) return ok('ok');
          throw Object.assign(new Error('exit 127: ' + cmd), { exitCode: 127, stdout: '', stderr: '' });
        },
      },
      async kill() {
        record({ type: 'kill', name });
        return true;
      },
    };
  },
};
`;

interface FakeEvent {
  type: 'build' | 'create' | 'kill';
  name: string;
  fileContextPath?: string;
  dockerfile?: string;
  cpuCount?: number;
  memoryMB?: number;
}

interface SdkRun {
  status: number | null;
  stdout: string;
  events: FakeEvent[];
  receipt: {
    allVerified: boolean;
    entries: Array<{
      name: string;
      provider: string;
      templateId?: string;
      built?: boolean;
      verified?: boolean;
      problems?: string[];
    }>;
  };
}

function runSdkBuild(extraEnv: Record<string, string> = {}): SdkRun {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sized-templates-sdk-'));
  try {
    const sdkModule = path.join(scratch, 'fake-e2b.mjs');
    const log = path.join(scratch, 'events.jsonl');
    const receiptPath = path.join(scratch, 'receipt.json');
    writeFileSync(sdkModule, FAKE_E2B_SDK);
    writeFileSync(log, '');
    const result = spawnSync(
      process.execPath,
      [buildScript, '--execute', '--via', 'sdk', '--receipt', receiptPath],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          E2B_API_KEY: 'test-key-not-used',
          E2B_SDK_MODULE: sdkModule,
          FAKE_E2B_LOG: log,
          ...extraEnv,
        },
      }
    );
    return {
      status: result.status,
      stdout: result.stdout,
      events: readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeEvent),
      receipt: JSON.parse(readFileSync(receiptPath, 'utf8')) as SdkRun['receipt'],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

check('the SDK path builds every plan entry from its one source with its size', () => {
  const run = runSdkBuild();
  assert.strictEqual(run.status, 0, run.stdout);
  const builds = run.events.filter((event) => event.type === 'build');
  assert.deepStrictEqual(
    builds.map((event) => event.name).sort(),
    plan.map((entry) => entry.name).sort()
  );
  for (const entry of plan) {
    const build = builds.find((event) => event.name === entry.name);
    assert.deepStrictEqual(build, {
      type: 'build',
      name: entry.name,
      fileContextPath: path.join(templatesDir, entry.source),
      dockerfile: path.join(templatesDir, entry.source, entry.dockerfile),
      cpuCount: entry.cpu,
      memoryMB: entry.memoryGb * 1024,
    });
  }
  for (const entry of plan) {
    const named = run.events.filter((event) => event.name === entry.name).map((e) => e.type);
    assert.deepStrictEqual(named, ['build', 'create', 'kill'], entry.name);
  }
  assert.strictEqual(run.receipt.allVerified, true);
  for (const record of run.receipt.entries) {
    assert.strictEqual(record.verified, true, record.name);
    assert.strictEqual(record.templateId, `tpl-${record.name}`);
  }
  assert.match(run.stdout, /Set E2B_SANDBOX_TEMPLATES=grid/);
});

check('a wrong-sized template fails the SDK run and withholds the grid go-ahead', () => {
  const bad = plan[plan.length - 1].name;
  const run = runSdkBuild({ FAKE_E2B_BAD_NPROC: bad });
  assert.strictEqual(run.status, 1, run.stdout);
  assert.strictEqual(run.receipt.allVerified, false);
  const record = run.receipt.entries.find((entry) => entry.name === bad);
  assert.strictEqual(record?.verified, false);
  assert.match(record?.problems?.join('; ') ?? '', /nproc 1, expected/);
  assert.ok(
    run.events.some((event) => event.type === 'kill' && event.name === bad),
    'the wrong-sized sandbox is still killed'
  );
  assert.doesNotMatch(run.stdout, /Set E2B_SANDBOX_TEMPLATES=grid/);
});

check('a size E2B refuses to build fails the run but every other size is still built', () => {
  const failed = plan.find((entry) => entry.provider === 'claude' && entry.memoryGb > 4)!;
  const run = runSdkBuild({ FAKE_E2B_BUILD_FAIL: failed.name });
  assert.strictEqual(run.status, 1, run.stdout);
  assert.strictEqual(run.receipt.allVerified, false);
  for (const record of run.receipt.entries) {
    const types = run.events.filter((event) => event.name === record.name).map((e) => e.type);
    if (record.name === failed.name) {
      assert.deepStrictEqual(types, ['build'], record.name);
      assert.strictEqual(record.built, false);
      assert.match(record.problems?.join('; ') ?? '', /8192 MiB/);
    } else {
      assert.deepStrictEqual(types, ['build', 'create', 'kill'], record.name);
      assert.strictEqual(record.verified, true, record.name);
    }
  }
  assert.doesNotMatch(run.stdout, /Set E2B_SANDBOX_TEMPLATES=grid/);
});

console.log(`\nsandbox-size-templates: ${checks} checks passed`);
