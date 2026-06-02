#!/usr/bin/env tsx
/**
 * Black-box test runner — runs all or a specific domain's black-box tests.
 * Tests run concurrently for speed. Output is buffered per domain.
 *
 * Usage:
 *   npx tsx src/tests/blackbox/run.ts                               # run all (concurrent)
 *   npx tsx src/tests/blackbox/run.ts agents                        # run one domain
 *   npx tsx src/tests/blackbox/run.ts agents,auth                   # run multiple domains
 *   npx tsx src/tests/blackbox/run.ts --concurrency=6               # cap concurrency
 *   BLACKBOX_TEST_CASE_CONCURRENCY=30 npx tsx src/tests/blackbox/run.ts agents
 *   npx tsx src/tests/blackbox/run.ts --list                        # list available domains
 */
import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { resolve, dirname, join } from 'path';

function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

const blackboxDir = dirname(new URL(import.meta.url).pathname);
const allFiles = readdirSync(blackboxDir)
  .filter((f) => f.endsWith('.blackbox.ts'))
  .sort();
const allDomains = allFiles.map((f) => f.replace('.blackbox.ts', ''));

const rawArgs = process.argv.slice(2);
let listOnly = false;
let domainsArg: string | undefined;
let concurrencyArg: number | undefined;

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--list') {
    listOnly = true;
    continue;
  }
  if (arg === '--concurrency') {
    const value = rawArgs[i + 1];
    if (!value) {
      process.stderr.write('Missing value for --concurrency\n');
      process.exit(1);
    }
    concurrencyArg = Number(value);
    i++;
    continue;
  }
  if (arg.startsWith('--concurrency=')) {
    concurrencyArg = Number(arg.split('=')[1]);
    continue;
  }
  if (arg.startsWith('--')) {
    process.stderr.write(`Unknown option: ${arg}\n`);
    process.exit(1);
  }
  if (domainsArg) {
    process.stderr.write(`Multiple domain arguments provided: "${domainsArg}" and "${arg}"\n`);
    process.exit(1);
  }
  domainsArg = arg;
}

if (listOnly) {
  process.stdout.write('Available black-box test domains:\n\n');
  allDomains.forEach((d) => process.stdout.write(`  ${d}\n`));
  process.stdout.write(`\nTotal: ${allDomains.length} domains\n`);
  process.exit(0);
}

const requested = domainsArg
  ? domainsArg
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : allDomains;
if (requested.length === 0) {
  process.stderr.write('No black-box test domains selected.\n');
  process.exit(1);
}
const unknown = requested.filter((d) => !allDomains.includes(d));
if (unknown.length) {
  process.stderr.write(`Unknown domain(s): ${unknown.join(', ')}\n`);
  process.stderr.write(`Available: ${allDomains.join(', ')}\n`);
  process.exit(1);
}

if (concurrencyArg !== undefined && (!Number.isInteger(concurrencyArg) || concurrencyArg <= 0)) {
  process.stderr.write(
    `Invalid --concurrency value: ${concurrencyArg}. Expected a positive integer.\n`
  );
  process.exit(1);
}

const envConcurrencyValue = readEnv('BLACKBOX_TEST_CONCURRENCY', 'CONTRACT_TEST_CONCURRENCY');
const envConcurrency = envConcurrencyValue ? Number(envConcurrencyValue) : undefined;
if (envConcurrency !== undefined && (!Number.isInteger(envConcurrency) || envConcurrency <= 0)) {
  process.stderr.write(
    `Invalid BLACKBOX_TEST_CONCURRENCY/CONTRACT_TEST_CONCURRENCY: ${envConcurrencyValue}. Expected a positive integer.\n`
  );
  process.exit(1);
}
const parsedConcurrency = concurrencyArg ?? envConcurrency;
const concurrency =
  Number.isInteger(parsedConcurrency) && (parsedConcurrency as number) > 0
    ? Math.min(requested.length, parsedConcurrency as number)
    : Math.min(requested.length, 6);
const runId =
  readEnv('BLACKBOX_TEST_RUN_ID', 'CONTRACT_TEST_RUN_ID') || `${Date.now()}-${process.pid}`;
const envTimeoutMsValue = readEnv('BLACKBOX_TEST_TIMEOUT_MS', 'CONTRACT_TEST_TIMEOUT_MS');
const envTimeoutMs = envTimeoutMsValue ? Number(envTimeoutMsValue) : undefined;
if (envTimeoutMs !== undefined && (!Number.isInteger(envTimeoutMs) || envTimeoutMs <= 0)) {
  process.stderr.write(
    `Invalid BLACKBOX_TEST_TIMEOUT_MS/CONTRACT_TEST_TIMEOUT_MS: ${envTimeoutMsValue}. Expected a positive integer.\n`
  );
  process.exit(1);
}
const timeoutMs = envTimeoutMs ?? 15 * 60 * 1000;
const artifactDir = readEnv('BLACKBOX_TEST_ARTIFACT_DIR', 'CONTRACT_TEST_ARTIFACT_DIR');
const rawCaseConcurrency = readEnv(
  'BLACKBOX_TEST_CASE_CONCURRENCY',
  'CONTRACT_TEST_CASE_CONCURRENCY'
);
const caseConcurrency = rawCaseConcurrency ? Number(rawCaseConcurrency) : 30;

if (!Number.isInteger(caseConcurrency) || caseConcurrency <= 0) {
  process.stderr.write(
    `Invalid BLACKBOX_TEST_CASE_CONCURRENCY/CONTRACT_TEST_CASE_CONCURRENCY: ${rawCaseConcurrency}. Expected a positive integer.\n`
  );
  process.exit(1);
}

if (artifactDir) {
  mkdirSync(artifactDir, { recursive: true });
}

process.stdout.write(
  `Running black-box tests for ${requested.length} domain(s) with domainConcurrency=${concurrency}, caseConcurrency=${caseConcurrency} (runId=${runId})...\n\n`
);

interface Result {
  domain: string;
  passed: boolean;
  duration: number;
  output: string;
  logPath?: string;
}

function runDomain(domain: string, workerIndex: number): Promise<Result> {
  return new Promise((res) => {
    const file = resolve(blackboxDir, `${domain}.blackbox.ts`);
    const cwd = resolve(blackboxDir, '../../..');
    const start = Date.now();
    const chunks: Buffer[] = [];
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    let settled = false;

    const child = spawn(npxCmd, ['tsx', file], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        BLACKBOX_TEST_RUN_ID: runId,
        BLACKBOX_TEST_DOMAIN: domain,
        BLACKBOX_TEST_WORKER_INDEX: String(workerIndex),
        BLACKBOX_TEST_CASE_CONCURRENCY: String(caseConcurrency),
        CONTRACT_TEST_RUN_ID: runId,
        CONTRACT_TEST_DOMAIN: domain,
        CONTRACT_TEST_WORKER_INDEX: String(workerIndex),
        CONTRACT_TEST_CASE_CONCURRENCY: String(caseConcurrency),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      res({
        domain,
        passed: false,
        duration: Date.now() - start,
        output: `${Buffer.concat(chunks).toString()}\n[runner] Timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      res({
        domain,
        passed: false,
        duration: Date.now() - start,
        output: `${Buffer.concat(chunks).toString()}\n[runner] Failed to spawn: ${error.message}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      res({
        domain,
        passed: code === 0,
        duration: Date.now() - start,
        output: Buffer.concat(chunks).toString(),
      });
    });
  });
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, workerIndex: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(workerIndex: number): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], workerIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(i)));
  return results;
}

async function main(): Promise<void> {
  const results = await runWithConcurrency(requested, concurrency, runDomain);
  if (artifactDir) {
    for (const result of results) {
      const logPath = join(artifactDir, `${result.domain}.log`);
      writeFileSync(logPath, result.output);
      result.logPath = logPath;
    }
  }

  // Print output for failed domains so you can see what went wrong
  const failures = results.filter((r) => !r.passed);
  for (const r of failures) {
    process.stdout.write(`--- FAIL: ${r.domain} ---\n`);
    process.stdout.write(`${r.output}\n`);
  }

  process.stdout.write(`${'='.repeat(60)}\n`);
  process.stdout.write('\nBlack-box Test Summary:\n\n');
  for (const r of results) {
    process.stdout.write(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.domain} (${r.duration}ms)\n`);
  }
  const passed = results.filter((r) => r.passed).length;
  const failed = failures.length;
  process.stdout.write(`\n${passed} passed, ${failed} failed, ${results.length} total\n`);
  if (artifactDir) {
    writeFileSync(
      join(artifactDir, 'summary.json'),
      JSON.stringify(
        {
          runId,
          requested,
          domainConcurrency: concurrency,
          caseConcurrency,
          timeoutMs,
          passed,
          failed,
          results: results.map((result) => ({
            domain: result.domain,
            passed: result.passed,
            duration: result.duration,
            logPath: result.logPath,
          })),
        },
        null,
        2
      )
    );
  }
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(
    `\nBlack-box test runner crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
