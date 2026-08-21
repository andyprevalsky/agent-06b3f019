import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

type UnitResult = {
  durationMs: number;
  exitCode: number;
  file: string;
  output: string;
};

const backendDir = resolve(__dirname, '..');
const unitDir = join(backendDir, 'src', 'tests', 'unit');
const logDir = join(backendDir, 'coverage', 'unit-run');
const requestedConcurrency = Number.parseInt(process.env.BACKEND_UNIT_CONCURRENCY ?? '6', 10);
const coverageDir = process.env.BACKEND_UNIT_COVERAGE_DIR;

if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1) {
  console.error('BACKEND_UNIT_CONCURRENCY must be a positive integer.');
  process.exit(2);
}

/**
 * Point DB-touching unit tests at the per-workspace local Postgres.
 *
 * `back-end/.env`'s DATABASE_URL is the REMOTE Supabase pooler — the same database prod uses.
 * Inheriting it here means unit tests create and delete real `Agent`/`Message` rows in production,
 * and every query pays 150-400ms instead of 1-5ms. That latency is not just slow: it makes
 * timing-sensitive suites nondeterministic under concurrency (observed 2026-08-05,
 * `workflow-restart-tools` blew a 10s interactive-transaction budget and
 * `purchase-provider-resolution-boundaries` flaked — both pass in isolation).
 *
 * `scripts/run-blackbox-tests.sh` already does this redirect and documents exactly why; the unit
 * runner simply never did. Mirrors its resolution: container `victoria-db-$WORKSPACE` on
 * CONDUCTOR_PORT+5, else system Postgres on 5432.
 *
 * Both DATABASE_URL and DIRECT_URL must be overridden — Prisma reads `directUrl` for migrations
 * and some clients, so overriding only DATABASE_URL still lets writes reach prod.
 */
function resolveLocalDatabaseEnv(): Record<string, string> | undefined {
  const explicit = process.env.BACKEND_UNIT_DATABASE_URL?.trim();
  if (explicit) return { DATABASE_URL: explicit, DIRECT_URL: explicit };

  const workspace =
    process.env.CONDUCTOR_WORKSPACE_NAME?.trim() || basename(resolve(backendDir, '..'));

  // Resolve by CONTAINER NAME, never by CONDUCTOR_PORT+5 arithmetic. Ports collide across
  // worktrees — in this repo CONDUCTOR_PORT+5 has resolved to a SIBLING workspace's
  // `victoria-db-*` container, and probing it blindly would run our tests against, and mutate,
  // another workspace's database. The container name is unambiguous.
  const candidates: Array<{ url: string; label: string }> = [];
  try {
    const mapping = execFileSync('docker', ['port', `victoria-db-${workspace}`, '5432/tcp'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const port = /:(\d+)\s*$/.exec(mapping.split('\n')[0] ?? '')?.[1];
    if (port !== undefined) {
      candidates.push({
        url: `postgresql://postgres:postgres@localhost:${port}/postgres`,
        label: `container victoria-db-${workspace} (:${port})`,
      });
    }
  } catch {
    // Docker unavailable or no container for this workspace.
  }
  candidates.push({
    url: 'postgresql://postgres:postgres@localhost:5432/postgres',
    label: 'system Postgres (:5432)',
  });

  for (const candidate of candidates) {
    // Reachable is NOT the same as usable. A bare local Postgres accepts connections while having
    // zero tables, and redirecting to it would fail every DB-touching test with "relation does not
    // exist" — worse than the remote DB it replaced. Require the schema to actually be present.
    try {
      const tables = execFileSync(
        'psql',
        [
          candidate.url,
          '-v',
          'ON_ERROR_STOP=1',
          '-tAc',
          "select count(*) from information_schema.tables where table_schema='public'",
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (Number.parseInt(tables, 10) > 0) {
        console.log(`Unit tests -> ${candidate.label} [${tables} tables]`);
        return { DATABASE_URL: candidate.url, DIRECT_URL: candidate.url };
      }
      console.warn(`Skipping ${candidate.label}: reachable but has no schema (0 tables).`);
    } catch {
      // unreachable; try the next candidate
    }
  }
  return undefined;
}

const localDatabaseEnv = resolveLocalDatabaseEnv();
if (localDatabaseEnv === undefined) {
  // This runner does not load dotenv (the tests do), so read .env directly to name the host the
  // tests will actually hit. A warning that says "unknown host" is not actionable.
  let configuredUrl = process.env.DATABASE_URL ?? '';
  if (configuredUrl === '') {
    try {
      const envFile = readFileSync(join(backendDir, '.env'), 'utf8');
      configuredUrl = /^DATABASE_URL=["']?([^"'\n]+)/m.exec(envFile)?.[1] ?? '';
    } catch {
      // .env unreadable; fall through to the generic message
    }
  }
  const remoteHost = /@([^/?]+)/.exec(configuredUrl)?.[1] ?? 'the DATABASE_URL in back-end/.env';
  console.warn(
    `\n⚠️  No local Postgres found — unit tests will run against ${remoteHost}.\n` +
      `   This is the SHARED/PROD database: tests will mutate real rows and DB-timing suites\n` +
      `   may flake from network latency. Start the workspace DB (scripts/run.sh) or set\n` +
      `   BACKEND_UNIT_DATABASE_URL to a localhost URL.\n`
  );
}

async function findTests(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findTests(path);
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
    })
  );
  return nested.flat().sort();
}

async function main(): Promise<void> {
  const tests = await findTests(unitDir);
  const concurrency = Math.min(requestedConcurrency, tests.length || 1);
  const results: UnitResult[] = [];
  const activeChildren = new Set<ChildProcess>();
  let nextTestIndex = 0;
  let interrupted = false;

  await mkdir(logDir, { recursive: true });
  console.log(`Running ${tests.length} unit test file(s) with concurrency=${concurrency}...`);

  function stopChildren(signal: NodeJS.Signals): void {
    interrupted = true;
    for (const child of activeChildren) child.kill(signal);
  }

  process.once('SIGINT', () => stopChildren('SIGINT'));
  process.once('SIGTERM', () => stopChildren('SIGTERM'));

  async function runTest(file: string): Promise<UnitResult> {
    const startedAt = performance.now();
    const chunks: Buffer[] = [];
    // Preserve one isolated process per file without npm/tsx wrapper processes.
    const child = spawn(process.execPath, ['--import', 'tsx', file], {
      cwd: backendDir,
      env: {
        ...process.env,
        ...localDatabaseEnv,
        ...(coverageDir === undefined ? {} : { NODE_V8_COVERAGE: coverageDir }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));

    const exitCode = await new Promise<number>((resolveExit) => {
      child.once('error', (error) => {
        chunks.push(Buffer.from(`\nFailed to start unit test: ${String(error)}\n`));
        resolveExit(1);
      });
      child.once('close', (code, signal) => {
        resolveExit(code ?? (signal ? 128 : 1));
      });
    });
    activeChildren.delete(child);

    const result = {
      durationMs: Math.round(performance.now() - startedAt),
      exitCode,
      file,
      output: Buffer.concat(chunks).toString('utf8'),
    };
    const fileLabel = relative(unitDir, file);
    const logPath = join(logDir, fileLabel.replace(/\.test\.ts$/, '.log'));
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, result.output);
    console.log(`  ${exitCode === 0 ? 'PASS' : 'FAIL'}  ${fileLabel} (${result.durationMs}ms)`);
    return result;
  }

  async function worker(): Promise<void> {
    while (!interrupted) {
      const index = nextTestIndex++;
      if (index >= tests.length) return;
      results.push(await runTest(tests[index]));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (interrupted) process.exit(130);

  const failures = results.filter((result) => result.exitCode !== 0);
  if (failures.length > 0) {
    console.error(`\n${failures.length}/${results.length} unit test file(s) failed.`);
    for (const failure of failures) {
      console.error(`\n=== ${relative(unitDir, failure.file)} ===`);
      console.error(failure.output.trimEnd());
    }
    process.exit(1);
  }
  console.log(`\n${results.length} unit test file(s) passed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
