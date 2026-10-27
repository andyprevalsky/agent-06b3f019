#!/usr/bin/env node
// Build the C16 sized code-agent templates from ONE source per provider.
//
//   e2b-templates/sized-templates.json ── grid {cpu × memoryGb}, providers {source dir, Dockerfile}
//     └─ for each provider × grid point:
//          e2b template build --path <source> --dockerfile <the one Dockerfile>
//                             --name <prefix>-c<cpu>-m<mem> --cpu-count <cpu> --memory-mb <mem*1024>
//                             --config <temporary e2b.toml>   (the committed e2b.toml is never rewritten)
//
// Only CPU and memory differ between sizes, so they cannot drift. The ws-server
// and Rose tools are overlaid at session start, so a rebuild is needed only when
// the Dockerfile changes (rebuild every size together).
//
//   node e2b-templates/build-sized-templates.mjs                # dry run: print the commands
//   node e2b-templates/build-sized-templates.mjs --json         # the build plan as JSON (structural test)
//   node e2b-templates/build-sized-templates.mjs --execute [--provider claude|codex]
//
// After a successful build set E2B_SANDBOX_TEMPLATES=grid on the backend (the
// names follow sizedTemplateName). This is a deploy item: it creates billed templates.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2B_CLI = process.env.E2B_CLI || 'npx --yes @e2b/cli@1';

export function loadConfig() {
  return JSON.parse(readFileSync(join(HERE, 'sized-templates.json'), 'utf8'));
}

function teamId(sourceDir) {
  const toml = readFileSync(join(HERE, sourceDir, 'e2b.toml'), 'utf8');
  const match = toml.match(/^team_id\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

/** Every template to build: one entry per provider × grid point. */
export function buildPlan(config = loadConfig()) {
  const { cpu, memoryGb } = config.grid;
  if (cpu.length * memoryGb.length > config.maxGridPoints) {
    throw new Error(`grid has ${cpu.length * memoryGb.length} sizes; the limit is ${config.maxGridPoints}`);
  }
  const plan = [];
  for (const [provider, spec] of Object.entries(config.providers)) {
    for (const c of cpu) {
      for (const m of memoryGb) {
        plan.push({
          provider,
          name: `${spec.namePrefix}-c${c}-m${m}`,
          cpu: c,
          memoryGb: m,
          source: spec.source,
          dockerfile: spec.dockerfile,
          team: teamId(spec.source),
        });
      }
    }
  }
  return plan;
}

function commandFor(entry, configPath) {
  return [
    ...E2B_CLI.split(' '),
    'template',
    'build',
    '--path',
    join(HERE, entry.source),
    '--dockerfile',
    entry.dockerfile,
    '--name',
    entry.name,
    '--cpu-count',
    String(entry.cpu),
    '--memory-mb',
    String(entry.memoryGb * 1024),
    ...(entry.team ? ['--team', entry.team] : []),
    '--config',
    configPath,
  ];
}

function main(argv) {
  const provider = argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : null;
  const plan = buildPlan().filter((entry) => provider === null || entry.provider === provider);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const execute = argv.includes('--execute');
  const scratch = mkdtempSync(join(tmpdir(), 'e2b-sized-'));
  try {
    for (const entry of plan) {
      const configPath = join(scratch, `${entry.name}.toml`);
      writeFileSync(
        configPath,
        [
          `template_name = "${entry.name}"`,
          `dockerfile = "${entry.dockerfile}"`,
          ...(entry.team ? [`team_id = "${entry.team}"`] : []),
          `cpu_count = ${entry.cpu}`,
          `memory_mb = ${entry.memoryGb * 1024}`,
          '',
        ].join('\n')
      );
      const command = commandFor(entry, configPath);
      console.log(`${execute ? 'building' : 'would run'}: ${command.join(' ')}`);
      if (!execute) continue;
      const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`build failed for ${entry.name} (exit ${result.status})`);
        return 1;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    execute
      ? 'Done. Set E2B_SANDBOX_TEMPLATES=grid on the backend.'
      : 'Dry run. Pass --execute to build (creates billed E2B templates).'
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
