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

const requestedRaw = domainsArg
  ? domainsArg
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : allDomains;
if (requestedRaw.length === 0) {
  process.stderr.write('No black-box test domains selected.\n');
  process.exit(1);
}
const unknown = requestedRaw.filter((d) => !allDomains.includes(d));
if (unknown.length) {
  process.stderr.write(`Unknown domain(s): ${unknown.join(', ')}\n`);
  process.stderr.write(`Available: ${allDomains.join(', ')}\n`);
  process.exit(1);
}

// Operational escape hatch for domains blocked by an external outage the runner
// cannot fix in code — e.g. a third-party quota exhaustion that resets on a
// known date. Defaults to empty (no domain is ever skipped silently); when set,
// every dropped domain is announced loudly so a skip can never masquerade as a
// pass. This is NOT a way to duck a real regression — only use it for a domain
// that is red purely because of an external billing/credential block.
const skipDomains = new Set(
  (readEnv('BLACKBOX_TEST_SKIP_DOMAINS', 'CONTRACT_TEST_SKIP_DOMAINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const skippedDomains = requestedRaw.filter((d) => skipDomains.has(d));
const requested = requestedRaw.filter((d) => !skipDomains.has(d));
if (skippedDomains.length) {
  process.stdout.write(
    `⚠️  SKIPPING ${skippedDomains.length} blackbox domain(s) via BLACKBOX_TEST_SKIP_DOMAINS (external block, NOT verified): ${skippedDomains.join(', ')}\n\n`
  );
}
if (requested.length === 0) {
  process.stderr.write('No black-box test domains left to run after skip filtering.\n');
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
// These domains assert whole-database aggregates or read/write the shared
// benchmark catalog cache. Running them alongside fixture writers or the Hub
// catalog editor makes one test observe multiple global snapshots. Every
// fixture-scoped domain still uses the parallel pool.
const lateExclusiveDomainNames = new Set([
  'admin-health',
  'benchmarks',
  'benchmarks-hub',
  'benchmarks-hub.part2',
  'benchmarks-test-prompts',
  // These owning injection tests exercise cancellation and a process RSS
  // budget. Run them after the fixture-writing pool has drained so CPU/DB
  // contention from sibling domains cannot obscure their runtime contract.
  'browser-origin-injection-memory',
  'steel-injection',
  // Its live Kernel/Steel auth-persist case closes a real session under the
  // product's 6s signed-in-state harvest budget. In the shared pool sibling
  // domains saturated the local DB (single queries at ~2s), the cookie write
  // spent the budget and localStorage was never persisted (2026-10-20, 2/3
  // coverage runs; it passes alone). Measure that contract uncontended.
  'browser-provider',
  // Its Rose-in-Rose HMR case measures agent write → preview DOM latency through
  // a real Vite dev server (≤ 3 s, 10 s hard wait). In the shared pool CPU-bound
  // sibling domains starved Vite and the update missed the wait (2026-10-27, 2/3
  // coverage runs; it passes alone). Measure that product latency uncontended.
  'code-preview',
  // Its feedback cases deliberately set a process-wide funded-key cooldown.
  // Keep that mutation after every other domain that may need the key.
  'codex-code',
  // It publishes the singleton queue pointer under the global exclusive
  // queue-admission lock, which waits for every sibling workflow start holding
  // the shared side; under the parallel coverage pool its 10s interactive
  // transaction expired (2026-10-27, 2 of 4 coverage runs; it passes alone).
  'agent-queue-pointer',
  // Its archived-agent status backfill settles every archived non-terminal row in
  // the database and asserts a second run finds none; sibling fixture writers in
  // the parallel pool add archived rows mid-case (2026-10-27 coverage) and would
  // have their own rows rewritten by it.
  'agents',
]);
const domainWeights = new Map<string, number>([
  ['benchmarks-hub-pipeline', 90],
  ['browser-provider', 60],
  ['agents', 40],
  ['plaid', 32],
  ['codex-code', 28],
  ['proactive-sms', 20],
]);
const lateExclusiveDomains = requested.filter((domain) => lateExclusiveDomainNames.has(domain));
const parallelDomains = requested
  .filter((domain) => !lateExclusiveDomainNames.has(domain))
  .sort(
    (left, right) =>
      (domainWeights.get(right) ?? 0) - (domainWeights.get(left) ?? 0) || left.localeCompare(right)
  );
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
const exclusiveDomains = [...lateExclusiveDomains];
if (exclusiveDomains.length > 0) {
  process.stdout.write(`Exclusive lifecycle domains: ${exclusiveDomains.join(', ')}\n\n`);
}

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
    let settled = false;
    let lockAcquired = false;
    let lockMarkerTail = '';

    // `npx tsx` creates npm + tsx wrapper processes for every domain. Under
    // NODE_V8_COVERAGE those wrappers emit irrelevant coverage blobs that slow
    // merging without exercising product code.
    // The live treasury rail uses the same sandbox cardholders as agent benchmarks.
    // Hold their host-wide payment lock across mint, close, and recovery.
    const paymentDomain = domain === 'treasury-rails';
    const command = paymentDomain ? 'python3' : process.execPath;
    const args = paymentDomain
      ? [resolve(cwd, 'scripts/with-agentcard-lock.py'), process.execPath, '--import', 'tsx', file]
      : ['--import', 'tsx', file];
    const child = spawn(command, args, {
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

    function armTimeout(limitMs: number, phase: string): ReturnType<typeof setTimeout> {
      return setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        res({
          domain,
          passed: false,
          duration: Date.now() - start,
          output: `${Buffer.concat(chunks).toString()}\n[runner] ${phase} timed out after ${limitMs}ms`,
        });
      }, limitMs);
    }

    // The provider sandbox is shared across workspaces. Give the test its normal
    // per-domain budget only after its host-wide lock has been acquired.
    let timeout = armTimeout(
      paymentDomain ? 2 * 60 * 60 * 1000 : timeoutMs,
      paymentDomain ? 'AgentCard lock wait' : 'Domain'
    );
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => {
      chunks.push(d);
      if (!paymentDomain || lockAcquired) return;
      lockMarkerTail = (lockMarkerTail + d.toString()).slice(-128);
      if (!lockMarkerTail.includes('AGENTCARD_LOCK_ACQUIRED')) return;
      lockAcquired = true;
      clearTimeout(timeout);
      timeout = armTimeout(timeoutMs, 'Domain');
    });

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
  const parallelResults = await runWithConcurrency(parallelDomains, concurrency, runDomain);
  // Aggregate assertions run after every parallel fixture writer has finished.
  // This also lets coverage run isolated unit processes during the long
  // provider domains without invalidating admin-health's whole-DB snapshot.
  const lateExclusiveResults = await runWithConcurrency(lateExclusiveDomains, 1, runDomain);
  const resultsByDomain = new Map(
    [...parallelResults, ...lateExclusiveResults].map((result) => [result.domain, result])
  );
  const results = requested.map((domain) => resultsByDomain.get(domain)!);
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
          exclusiveDomains,
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
  // process.exit() drops stdout still queued for the `tee` pipe, which cut the
  // failed-domain FAILURES section out of runner.log after the first 64 KB.
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `\nBlack-box test runner crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
