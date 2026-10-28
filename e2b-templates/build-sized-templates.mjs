#!/usr/bin/env node
// Build the C16 sized code-agent templates from ONE source per provider.
//
//   e2b-templates/sized-templates.json ── grid {cpu × memoryGb}, providers {source dir, Dockerfile}
//     └─ for each provider × grid point (name <prefix>-c<cpu>-m<mem>, cpu, memory <mem*1024> MB):
//          --via cli  e2b template build --path <source> --dockerfile <the one Dockerfile>
//                       --name … --cpu-count … --memory-mb … --config <temporary e2b.toml>
//                       (needs a personal E2B CLI login; the committed e2b.toml is never rewritten)
//          --via sdk  Template({fileContextPath: <source>}).fromDockerfile(<the one Dockerfile>)
//                       → Template.build(template, name, {cpuCount, memoryMB})
//                       (needs only E2B_API_KEY; builds into that key's team, which must be the
//                       backend's E2B_API_KEY team). Providers build in parallel, sizes in order;
//                       each size is verified as soon as it is built. A failed size (e.g. over
//                       the team's memory limit) is recorded and the remaining sizes still run.
//          verify     Sandbox.create(name): nproc == cpu, MemTotal within 15% of memory, the
//                       provider CLI (claude / codex) runs, ws-server + ws are installed; kill.
//
// Only CPU and memory differ between sizes, so they cannot drift. The ws-server
// and Rose tools are overlaid at session start, so a rebuild is needed only when
// the Dockerfile changes (rebuild every size together).
//
//   node e2b-templates/build-sized-templates.mjs                # dry run: print the CLI commands
//   node e2b-templates/build-sized-templates.mjs --json         # the build plan as JSON (structural test)
//   node e2b-templates/build-sized-templates.mjs --via sdk      # dry run of the SDK builds
//   node e2b-templates/build-sized-templates.mjs --execute --via sdk [--provider claude|codex]
//        [--missing] [--receipt <path>]   # build + verify; --missing builds only the sizes
//        that do not exist yet (every size is still verified); receipt default
//        .context/e2b-template-builds/
//   node e2b-templates/build-sized-templates.mjs --verify [--provider …]   # verify only
//   node e2b-templates/build-sized-templates.mjs --execute [--provider claude|codex]   # CLI login
//
// Only after every size verifies set E2B_SANDBOX_TEMPLATES=grid on the backend
// (the names follow sizedTemplateName): with `grid` the default size resolves to
// a sized template too. This is a deploy item: it creates billed templates.
// The E2B team refuses templates over 8192 MiB ("Memory can't be higher than 8192 MiB",
// 2026-10-28), so the grid's memory stops at 8 GB; a 16 GB size needs E2B support to
// raise that cap first.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2B_CLI = process.env.E2B_CLI || 'npx --yes @e2b/cli@1';
/** The e2b SDK module (a path to a stand-in module lets the structural test run offline). */
const E2B_SDK = process.env.E2B_SDK_MODULE || 'e2b';
/** The code-agent CLI every template of a provider must ship. */
const CLI_BINARY = { claude: 'claude', codex: 'codex' };
/** A VM reports a little less MemTotal than its configured memory. */
const MEMORY_TOLERANCE = 0.15;
const SANDBOX_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;

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
    throw new Error(
      `grid has ${cpu.length * memoryGb.length} sizes; the limit is ${config.maxGridPoints}`
    );
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

/** What the SDK build of a plan entry receives: the CLI's context, Dockerfile, name, cpu and memory. */
export function sdkBuildSpec(entry) {
  const fileContextPath = join(HERE, entry.source);
  return {
    name: entry.name,
    fileContextPath,
    dockerfilePath: join(fileContextPath, entry.dockerfile),
    cpuCount: entry.cpu,
    memoryMB: entry.memoryGb * 1024,
  };
}

function option(argv, flag) {
  return argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
}

function seconds(fromMs) {
  return Math.round((Date.now() - fromMs) / 100) / 10;
}

function loadSdk() {
  const specifier = isAbsolute(E2B_SDK) ? pathToFileURL(E2B_SDK).href : E2B_SDK;
  return import(specifier);
}

async function buildWithSdk(sdk, entry) {
  const spec = sdkBuildSpec(entry);
  const template = sdk
    .Template({ fileContextPath: spec.fileContextPath })
    .fromDockerfile(spec.dockerfilePath);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const info = await sdk.Template.build(template, spec.name, {
    cpuCount: spec.cpuCount,
    memoryMB: spec.memoryMB,
    onBuildLogs: (logEntry) => console.log(`[${spec.name}] ${logEntry.toString()}`),
  });
  return {
    templateId: info.templateId,
    buildId: info.buildId,
    startedAt,
    finishedAt: new Date().toISOString(),
    buildSeconds: seconds(started),
  };
}

/** Problems with one booted sandbox's size and contents (empty = verified). */
export function sizeProblems(entry, observed) {
  const problems = [];
  if (observed.nproc !== entry.cpu) problems.push(`nproc ${observed.nproc}, expected ${entry.cpu}`);
  const memoryGb = observed.memTotalKb / 1024 / 1024;
  if (!(Math.abs(memoryGb - entry.memoryGb) <= entry.memoryGb * MEMORY_TOLERANCE)) {
    problems.push(`MemTotal ${memoryGb.toFixed(2)} GiB, expected ${entry.memoryGb} GiB`);
  }
  if (!observed.cliPath) problems.push(`${CLI_BINARY[entry.provider]} is not on PATH`);
  if (!observed.cliVersion) problems.push(`${CLI_BINARY[entry.provider]} --version failed`);
  if (!observed.wsServer) problems.push('ws-server.mjs or its ws dependency is missing');
  return problems;
}

async function verifyWithSdk(sdk, entry) {
  const started = Date.now();
  const sandbox = await sdk.Sandbox.create(entry.name, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  const run = async (cmd) => {
    try {
      const result = await sandbox.commands.run(cmd, {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      return result.exitCode === 0 ? result.stdout.trim() : '';
    } catch (error) {
      if (typeof error?.exitCode === 'number') return '';
      throw error;
    }
  };
  try {
    const cli = CLI_BINARY[entry.provider];
    const observed = {
      sandboxId: sandbox.sandboxId,
      nproc: Number(await run('nproc')),
      memTotalKb: Number(/MemTotal:\s+(\d+)/.exec(await run('cat /proc/meminfo'))?.[1] ?? 0),
      cliPath: await run(`command -v ${cli}`),
      cliVersion: await run(`${cli} --version`),
      wsServer:
        (await run(
          'test -f /home/user/ws-server.mjs && test -d /home/user/node_modules/ws && echo ok'
        )) === 'ok',
    };
    const problems = sizeProblems(entry, observed);
    return {
      ...observed,
      verified: problems.length === 0,
      problems,
      verifySeconds: seconds(started),
    };
  } finally {
    await sandbox.kill();
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Build (unless verifyOnly; with missingOnly only absent names) and verify every entry. */
async function runSdk(plan, { verifyOnly, missingOnly, receiptPath }) {
  if (!process.env.E2B_API_KEY) {
    console.error('E2B_API_KEY is required (the backend key: templates are private to its team)');
    return 2;
  }
  const sdk = await loadSdk();
  const receipt = {
    via: 'sdk',
    mode: verifyOnly ? 'verify' : missingOnly ? 'build-missing' : 'build',
    startedAt: new Date().toISOString(),
    entries: plan.map((entry) => ({
      ...entry,
      memoryMB: entry.memoryGb * 1024,
    })),
  };
  const save = () => {
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  };
  save();
  const verifications = [];
  const verify = (record) => {
    const done = verifyWithSdk(sdk, record)
      .then((result) => Object.assign(record, result))
      .catch((error) =>
        Object.assign(record, {
          verified: false,
          problems: [errorText(error)],
        })
      )
      .then(() => {
        console.log(
          `${record.verified ? 'verified' : 'NOT verified'}: ${record.name}` +
            (record.verified
              ? ` (nproc ${record.nproc}, MemTotal ${record.memTotalKb} kB, ${record.cliVersion})`
              : ` — ${record.problems.join('; ')}`)
        );
        save();
      });
    verifications.push(done);
  };
  const providers = [...new Set(receipt.entries.map((record) => record.provider))];
  await Promise.all(
    providers.map(async (provider) => {
      for (const record of receipt.entries.filter((entry) => entry.provider === provider)) {
        if (!verifyOnly && missingOnly && (await sdk.Template.exists(record.name))) {
          record.built = 'existing';
          console.log(`exists, not rebuilt: ${record.name}`);
          save();
        } else if (!verifyOnly) {
          console.log(
            `building (sdk): ${record.name} cpu ${record.cpu} memory ${record.memoryMB} MB`
          );
          try {
            Object.assign(record, await buildWithSdk(sdk, record));
            console.log(`built: ${record.name} ${record.templateId} in ${record.buildSeconds}s`);
          } catch (error) {
            Object.assign(record, {
              built: false,
              verified: false,
              problems: [errorText(error)],
            });
            console.error(`build failed for ${record.name}: ${errorText(error)}`);
            save();
            continue; // a size limit fails one size; still try (and report) the others
          }
          record.built = true;
          save();
        }
        verify(record);
      }
    })
  );
  await Promise.all(verifications);
  receipt.finishedAt = new Date().toISOString();
  receipt.allVerified = receipt.entries.every((record) => record.verified === true);
  save();
  console.log(`receipt: ${receiptPath}`);
  if (!receipt.allVerified) {
    console.error('Not every size verified: do NOT set E2B_SANDBOX_TEMPLATES=grid.');
    return 1;
  }
  console.log(
    `All ${receipt.entries.length} sizes verified. Set E2B_SANDBOX_TEMPLATES=grid on the backend.`
  );
  return 0;
}

function runCli(plan, execute) {
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
      const result = spawnSync(command[0], command.slice(1), {
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        console.error(
          `build failed for ${entry.name} (exit ${result.status}); without an E2B CLI login use --via sdk`
        );
        return 1;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(
    execute
      ? 'Done. Verify with --verify, then set E2B_SANDBOX_TEMPLATES=grid on the backend.'
      : 'Dry run. Pass --execute to build (creates billed E2B templates).'
  );
  return 0;
}

async function main(argv) {
  const provider = option(argv, '--provider');
  const plan = buildPlan().filter((entry) => provider === null || entry.provider === provider);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const via = option(argv, '--via') ?? 'cli';
  if (via !== 'cli' && via !== 'sdk') {
    console.error(`--via must be cli or sdk, not ${via}`);
    return 2;
  }
  const execute = argv.includes('--execute');
  const verifyOnly = argv.includes('--verify');
  const missingOnly = argv.includes('--missing');
  const receiptPath = resolve(
    option(argv, '--receipt') ??
      join(
        HERE,
        '..',
        '.context',
        'e2b-template-builds',
        `sized-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      )
  );
  if (verifyOnly || (via === 'sdk' && execute)) {
    return runSdk(plan, { verifyOnly, missingOnly, receiptPath });
  }
  if (via === 'sdk') {
    for (const entry of plan) {
      const spec = sdkBuildSpec(entry);
      console.log(
        `would build (sdk): ${spec.name} from ${spec.dockerfilePath} (context ${spec.fileContextPath}) ` +
          `cpuCount ${spec.cpuCount} memoryMB ${spec.memoryMB}`
      );
    }
    console.log('Dry run. Pass --execute to build and verify (creates billed E2B templates).');
    return 0;
  }
  return runCli(plan, execute);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
