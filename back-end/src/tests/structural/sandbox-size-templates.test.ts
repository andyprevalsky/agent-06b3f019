#!/usr/bin/env tsx
/**
 * Structural test (C16): every sized code-agent template comes from ONE source.
 *
 *   e2b-templates/sized-templates.json ──► build-sized-templates.mjs --json (the real build plan)
 *     ├─ grid == DEFAULT_SANDBOX_GRID (backend) and ≤ MAX_GRID_POINTS per provider
 *     ├─ each provider: every size uses the same source dir and the same Dockerfile,
 *     │    differing only in cpu / memory; names == sizedTemplateName(provider, size)
 *     ├─ no per-size copies are committed (extra e2b*.toml / *.Dockerfile under e2b-templates)
 *     ├─ both Dockerfiles install gh from GitHub's signed apt repository and bake no credential
 *     └─ --execute --via sdk (E2B_API_KEY, no CLI login), run against a stand-in e2b module:
 *          Template.build gets each plan entry's source dir, Dockerfile, name, cpu and memory;
 *          every size is booted and checked (nproc, MemTotal, provider CLI, gh) and its sandbox
 *          killed; one wrong-sized template fails the run and withholds the grid go-ahead;
 *          --missing builds only the absent sizes and still verifies every size
 *
 * Run: npx tsx src/tests/structural/sandbox-size-templates.test.ts
 */
import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  CLAUDE_CODE_TEMPLATE,
  DEFAULT_CLAUDE_CODE_TEMPLATE_ID,
} from '../../providers/claudeCodeTemplate';
import {
  DEFAULT_SANDBOX_GRID,
  defaultSandboxSize,
  MAX_GRID_POINTS,
  sandboxTemplateFor,
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

check('Claude templates pin a CLI that supports Opus 5.5', () => {
  const dockerfile = readFileSync(path.join(templatesDir, 'claude-code/e2b.Dockerfile'), 'utf8');
  const pin = dockerfile.match(/^ARG CLAUDE_CODE_VERSION=(\S+)$/m)?.[1];
  assert.ok(
    pin && /^2\.1\.\d+$/.test(pin) && Number(pin.split('.')[2]) >= 280,
    'Opus 5.5 needs CLI >= 2.1.280'
  );
  assert.ok(dockerfile.includes('npm install -g "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"'));
  const plan = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(templatesDir, 'build-template-version.mjs'),
        '--source',
        'claude-code',
        '--name',
        'claude-code-v21305',
      ],
      { encoding: 'utf8' }
    )
  );
  assert.strictEqual(plan.pins.CLAUDE_CODE_VERSION, pin);

  // The launched default is versioned with this pin in code (claudeCodeTemplate.ts):
  // a pin bump builds a new claude-code-v<pin>-c<cpu>-m<mem> template and moves it.
  assert.strictEqual(
    CLAUDE_CODE_TEMPLATE.claudeCodeVersion,
    pin,
    `claudeCodeTemplate.ts claudeCodeVersion != Dockerfile pin ${pin}; build a new template`
  );
  const size = CLAUDE_CODE_TEMPLATE.size;
  assert.strictEqual(
    CLAUDE_CODE_TEMPLATE.alias,
    `claude-code-v${pin.replace(/\./g, '')}-c${size.cpu}-m${size.memoryGb}`
  );
  // The built template's CPU/memory (e2b-templates/.context receipt: 2 vCPU, 4096 MB).
  assert.deepStrictEqual(size, { cpu: 2, memoryGb: 4 });
  assert.strictEqual(DEFAULT_CLAUDE_CODE_TEMPLATE_ID, CLAUDE_CODE_TEMPLATE.alias);
});

check('a stale per-environment Claude template id cannot override the pinned template', () => {
  // 2026-11-04: devbox envs still named kng6z68u1md05bfdhq47 (CLI 2.1.138), so the
  // real E2B smoke got "Claude Code 2.1.138 does not support this model".
  const keys = [
    'E2B_CLAUDE_CODE_TEMPLATE_ID',
    'E2B_SANDBOX_TEMPLATES',
    'CODE_SANDBOX_GRID',
    'CODE_SANDBOX_DEFAULT_CPU',
    'CODE_SANDBOX_DEFAULT_MEMORY_GB',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.E2B_CLAUDE_CODE_TEMPLATE_ID = 'kng6z68u1md05bfdhq47';
    delete process.env.E2B_SANDBOX_TEMPLATES;
    delete process.env.CODE_SANDBOX_GRID;
    delete process.env.CODE_SANDBOX_DEFAULT_CPU;
    delete process.env.CODE_SANDBOX_DEFAULT_MEMORY_GB;
    assert.strictEqual(
      sandboxTemplateFor('claude', defaultSandboxSize()),
      DEFAULT_CLAUDE_CODE_TEMPLATE_ID
    );
    // A configured default of another size never falls back to the 2x4 alias.
    process.env.CODE_SANDBOX_DEFAULT_CPU = '8';
    process.env.CODE_SANDBOX_DEFAULT_MEMORY_GB = '8';
    assert.deepStrictEqual(defaultSandboxSize(), { cpu: 8, memoryGb: 8 });
    assert.strictEqual(sandboxTemplateFor('claude', { cpu: 8, memoryGb: 8 }), null);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  const providersDir = path.join(repoRoot, 'back-end/src/providers');
  const readers = readdirSync(providersDir, { recursive: true, encoding: 'utf8' }).filter(
    (file) =>
      file.endsWith('.ts') &&
      readFileSync(path.join(providersDir, file), 'utf8').includes(
        'process.env.E2B_CLAUDE_CODE_TEMPLATE_ID'
      )
  );
  assert.deepStrictEqual(readers, [], `providers reading the env template id: ${readers}`);
});

check(
  'both code-agent Dockerfiles install gh from the official signed apt repo and bake no token',
  () => {
    for (const source of ['claude-code', 'codex-code']) {
      const dockerfile = readFileSync(path.join(templatesDir, source, 'e2b.Dockerfile'), 'utf8');
      const where = `${source}/e2b.Dockerfile`;
      // GitHub's keyring + apt source (signed-by), gh installed and run once at build time.
      for (const needle of [
        'https://cli.github.com/packages/githubcli-archive-keyring.gpg',
        'signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg',
        'https://cli.github.com/packages stable main',
        'apt-get install -y --no-install-recommends gh',
        '&& gh --version',
      ]) {
        assert.ok(dockerfile.includes(needle), `${where} is missing: ${needle}`);
      }
      // Never a piped installer for gh, and the apt lists are still cleaned after the install.
      assert.doesNotMatch(
        dockerfile,
        /cli\.github\.com[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
        `${where} pipes the gh installer into a shell`
      );
      // The RUN instruction that installs gh (the blank-line separated block) cleans its own apt lists.
      const installBlock = dockerfile
        .split(/\n\s*\n/)
        .find((block) => block.includes('apt-get install -y --no-install-recommends gh'));
      assert.ok(installBlock, `${where} has no RUN block that installs gh`);
      assert.ok(
        installBlock.indexOf('rm -rf /var/lib/apt/lists/*') >
          installBlock.indexOf('apt-get install -y --no-install-recommends gh'),
        `${where} must clean the apt lists in the same RUN, after installing gh`
      );
      // No credential is baked into the image: gh reads GITHUB_TOKEN / GH_TOKEN at run time.
      assert.doesNotMatch(
        dockerfile,
        /^\s*(ENV|ARG)\s+\S*(TOKEN|SECRET|PASSWORD)\S*/im,
        `${where} bakes a credential variable`
      );
      assert.doesNotMatch(
        dockerfile,
        /gh auth (login|token)|x-access-token|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_/
      );
    }
  }
);

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
 * (FAKE_E2B_BAD_NPROC=<name> makes that one report 1 vCPU; FAKE_E2B_NO_GH=<name> makes that
 * one lack the GitHub CLI; FAKE_E2B_BUILD_FAIL=<name>
 * rejects that build the way E2B rejects a size over the team's memory limit;
 * FAKE_E2B_EXISTING=<name,…> are templates that already exist).
 */
const FAKE_E2B_SDK = `
import { appendFileSync } from 'node:fs';
const record = (event) => appendFileSync(process.env.FAKE_E2B_LOG, JSON.stringify(event) + '\\n');
const built = new Map();
const existing = new Set((process.env.FAKE_E2B_EXISTING ?? '').split(',').filter(Boolean));
const sizeOf = (name) => {
  const [, cpu, memoryGb] = /-c(\\d+)-m(\\d+)$/.exec(name);
  return { cpuCount: Number(cpu), memoryMB: Number(memoryGb) * 1024 };
};
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
Template.exists = async (name) => {
  if (process.env.FAKE_E2B_EXISTS_FAIL === name) throw new Error('controlled exists rejection');
  return existing.has(name) || built.has(name);
};
const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '' });
export const Sandbox = {
  async create(name) {
    const size = built.get(name) ?? (existing.has(name) ? sizeOf(name) : undefined);
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
          if (cmd === 'gh --version') {
            if (process.env.FAKE_E2B_NO_GH === name) {
              throw Object.assign(new Error('exit 127: gh'), { exitCode: 127, stdout: '', stderr: '' });
            }
            return ok('gh version 2.103.3 (fake)');
          }
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
      built?: boolean | 'existing';
      verified?: boolean;
      problems?: string[];
    }>;
  };
}

function runSdkBuild(extraEnv: Record<string, string> = {}, extraArgs: string[] = []): SdkRun {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'sized-templates-sdk-'));
  try {
    const sdkModule = path.join(scratch, 'fake-e2b.mjs');
    const log = path.join(scratch, 'events.jsonl');
    const receiptPath = path.join(scratch, 'receipt.json');
    writeFileSync(sdkModule, FAKE_E2B_SDK);
    writeFileSync(log, '');
    const result = spawnSync(
      process.execPath,
      [buildScript, '--execute', '--via', 'sdk', ...extraArgs, '--receipt', receiptPath],
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

check('a template without gh fails the SDK run and withholds the grid go-ahead', () => {
  const bad = plan[0].name;
  const run = runSdkBuild({ FAKE_E2B_NO_GH: bad });
  assert.strictEqual(run.status, 1, run.stdout);
  assert.strictEqual(run.receipt.allVerified, false);
  const record = run.receipt.entries.find((entry) => entry.name === bad);
  assert.strictEqual(record?.verified, false);
  assert.match(record?.problems?.join('; ') ?? '', /gh --version failed/);
  assert.ok(
    run.events.some((event) => event.type === 'kill' && event.name === bad),
    'the sandbox without gh is still killed'
  );
  assert.doesNotMatch(run.stdout, /Set E2B_SANDBOX_TEMPLATES=grid/);
  // every other size still verifies, with its gh version recorded
  for (const other of run.receipt.entries.filter((entry) => entry.name !== bad)) {
    assert.strictEqual(other.verified, true, other.name);
    assert.match(other.ghVersion ?? '', /^gh version \d/, other.name);
  }
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

check('--missing builds only the absent sizes and still verifies every size', () => {
  const smallest = Math.min(...config.grid.memoryGb);
  const present = plan.filter((entry) => entry.memoryGb === smallest).map((entry) => entry.name);
  const run = runSdkBuild({ FAKE_E2B_EXISTING: present.join(',') }, ['--missing']);
  assert.strictEqual(run.status, 0, run.stdout);
  assert.deepStrictEqual(
    run.events
      .filter((event) => event.type === 'build')
      .map((event) => event.name)
      .sort(),
    plan
      .map((entry) => entry.name)
      .filter((name) => !present.includes(name))
      .sort()
  );
  for (const record of run.receipt.entries) {
    const types = run.events.filter((event) => event.name === record.name).map((e) => e.type);
    const expected = present.includes(record.name)
      ? ['create', 'kill']
      : ['build', 'create', 'kill'];
    assert.deepStrictEqual(types, expected, record.name);
    assert.strictEqual(record.built, present.includes(record.name) ? 'existing' : true);
    assert.strictEqual(record.verified, true, record.name);
  }
  assert.strictEqual(run.receipt.allVerified, true);
  assert.match(run.stdout, /Set E2B_SANDBOX_TEMPLATES=grid/);
});

check('invalid or missing provider refuses an empty success', () => {
  for (const args of [['--provider', 'typo', '--json'], ['--provider'], ['--provider', '--json']]) {
    const run = spawnSync(process.execPath, [buildScript, ...args], { encoding: 'utf8' });
    assert.strictEqual(run.status, 2, run.stdout + run.stderr);
  }
});

check('an exists failure records only that size without rebuilding it', () => {
  const failed = plan[0].name;
  const run = runSdkBuild({ FAKE_E2B_EXISTS_FAIL: failed }, ['--missing']);
  assert.strictEqual(run.status, 1);
  assert.strictEqual(run.receipt.allVerified, false);
  const record = run.receipt.entries.find((entry) => entry.name === failed);
  assert.strictEqual(record?.built, false);
  assert.strictEqual(record?.verified, false);
  assert.match(record?.problems?.join(' ') ?? '', /controlled exists rejection/);
  assert.strictEqual(run.events.filter((event) => event.name === failed).length, 0);
  assert.strictEqual(run.receipt.entries.filter((entry) => entry.verified).length, plan.length - 1);
  assert.strictEqual(run.events.filter((event) => event.type === 'kill').length, plan.length - 1);
});

check('a single-provider verification withholds the complete-grid go-ahead', () => {
  const run = runSdkBuild({}, ['--provider', 'codex']);
  assert.strictEqual(run.status, 0, run.stdout);
  assert.strictEqual(run.receipt.allVerified, true);
  assert.ok(run.receipt.entries.every((entry) => entry.provider === 'codex'));
  assert.doesNotMatch(run.stdout, /Set E2B_SANDBOX_TEMPLATES=grid/);
});

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  checks += 1;
  await fn();
  console.log(`  PASS ${name}`);
}

async function main(): Promise<void> {
  await checkAsync(
    'a sized Claude spawn with no template of its size never gets the 2x4 image',
    async () => {
      const { Sandbox } = await import('e2b');
      const { acquireCodeSandbox } = await import('../../providers/e2bCodeSessionSandbox');
      const keys = [
        'E2B_SANDBOX_TEMPLATES',
        'CODE_SANDBOX_DEFAULT_CPU',
        'CODE_SANDBOX_DEFAULT_MEMORY_GB',
      ];
      const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      const original = Sandbox.create.bind(Sandbox);
      const creates: string[] = [];
      (Sandbox as unknown as { create: (id: string) => Promise<never> }).create = (id) => {
        creates.push(id);
        return Promise.reject(new Error(`unexpected create ${id}`));
      };
      delete process.env.E2B_SANDBOX_TEMPLATES;
      process.env.CODE_SANDBOX_DEFAULT_CPU = '8';
      process.env.CODE_SANDBOX_DEFAULT_MEMORY_GB = '8';
      try {
        await assert.rejects(
          acquireCodeSandbox(null, DEFAULT_CLAUDE_CODE_TEMPLATE_ID, {}, 'Claude Code', {
            provider: 'claude',
          }),
          /No Claude Code sandbox template is built for 8 vCPU \/ 8 GB/
        );
        assert.deepStrictEqual(creates, [], 'no sandbox of the wrong size is created');
      } finally {
        (Sandbox as unknown as { create: unknown }).create = original;
        for (const key of keys) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
    }
  );
  console.log(`\nsandbox-size-templates: ${checks} checks passed`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
