import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { nonLocalDatabaseReason } from '../src/utils/localDatabaseUrl';
import { createIsolatedDatabase, ISOLATED_DATABASE_FILES } from './unit-test-database-isolation';

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
// Recheck is CPU-heavy. Under coverage it shares the host with the backend and
// 160 blackbox domains, so a 1s analyzer budget times out even on safe range
// queries. Run those files first, alone, and omit NODE_V8_COVERAGE on that
// child — inherited V8 coverage collection is enough load to miss the budget
// even with no sibling unit workers. Coverage of regexSafety.ts still lands
// via the instrumented backend / data-grep path.
const SERIAL_FIRST_FILES = new Set(['regex-safety.test.ts']);

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

  // The worktree DIRECTORY BASENAME is the canonical local-resource identity, not
  // CONDUCTOR_WORKSPACE_NAME. `scripts/lib/workspace-env.sh:normalize_conductor_workspace_env`
  // deliberately overrides a mismatched env var with the basename (a stale Conductor display name
  // is common), and run-coverage.sh / run-blackbox-tests.sh name the container from that. Trusting
  // the env var here resolves `victoria-db-<stale-name>`, finds nothing, and falls through to the
  // remote DB this redirect exists to avoid.
  const workspace = basename(resolve(backendDir, '..'));

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
      // Database name MUST be `victoria`, matching run-blackbox-tests.sh and the container's
      // POSTGRES_DB. The default `postgres` database exists but is EMPTY, so pointing at it
      // silently fails the schema probe below and falls through to the remote DB this function
      // exists to avoid.
      candidates.push({
        url: `postgresql://postgres:postgres@localhost:${port}/victoria`,
        label: `container victoria-db-${workspace} (:${port})`,
      });
    }
  } catch {
    // Docker unavailable or no container for this workspace.
  }
  candidates.push({
    url: 'postgresql://postgres:postgres@localhost:5432/victoria',
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

/**
 * Refuse to run DB-touching unit tests against a remote database.
 *
 * Fail-closed backstop for the resolver above. These tests create and delete real rows through
 * `providers/database`, which falls back to `back-end/.env` — whose DATABASE_URL is the PRODUCTION
 * Supabase pooler. Prod latency also blows Prisma's 10s interactive-transaction budget and
 * manufactures failures that look like real bugs.
 *
 * An UNSET DATABASE_URL is refused too: that is precisely the case that falls back to the prod
 * pooler, so treating it as "nothing to validate" would leave the original hazard open.
 * `nonLocalDatabaseReason` is the single shared definition of "local"
 * (src/utils/localDatabaseUrl.ts), so this runner, the checkpoint scripts, and
 * `providers/database` cannot drift apart.
 *
 * `resolved` is what the child processes will actually receive, so it — not the ambient
 * DATABASE_URL — is what gets judged. Checking the ambient value instead would reject a run the
 * resolver had already made safe.
 */
function assertLocalDatabaseUrl(resolved: Record<string, string> | undefined): void {
  // Deliberate, explicit remote runs stay possible.
  if (process.env.BACKEND_UNIT_ALLOW_REMOTE_DB === '1') return;
  const effectiveUrl = resolved?.DATABASE_URL ?? process.env.DATABASE_URL;
  const reason = nonLocalDatabaseReason(effectiveUrl);
  if (reason === null) return;

  // This runner does not load dotenv (the tests do), so read .env directly to name the host the
  // tests would have hit. An error that says "unknown host" is not actionable.
  let configuredUrl = effectiveUrl ?? '';
  if (configuredUrl === '') {
    try {
      const envFile = readFileSync(join(backendDir, '.env'), 'utf8');
      configuredUrl = /^DATABASE_URL=["']?([^"'\n]+)/m.exec(envFile)?.[1] ?? '';
    } catch {
      // .env unreadable; fall through to the generic reason
    }
  }
  // Parse rather than regex-match. `/@([^/?]+)/` matches from the FIRST '@', so a password
  // containing an unencoded '@' (postgresql://user:pa@ss@host/db) captures "ss@host" and writes a
  // credential fragment into terminal scrollback and CI logs.
  let remoteHost = 'the DATABASE_URL in back-end/.env';
  if (configuredUrl !== '') {
    try {
      remoteHost = new URL(configuredUrl).host;
    } catch {
      // Unparseable: keep the generic description rather than echoing the raw URL.
    }
  }
  console.error(
    `Refusing to run backend unit tests: ${reason} (${remoteHost}). These tests create and\n` +
      'delete real rows. Start the workspace DB (scripts/run.sh), run via `npm run test:coverage`\n' +
      '(which exports the local container URL), set BACKEND_UNIT_DATABASE_URL to a localhost URL,\n' +
      'or set BACKEND_UNIT_ALLOW_REMOTE_DB=1 to override deliberately.'
  );
  process.exit(2);
}

const localDatabaseEnv = resolveLocalDatabaseEnv();
assertLocalDatabaseUrl(localDatabaseEnv);

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
  const serialFirst = tests.filter((file) => SERIAL_FIRST_FILES.has(basename(file)));
  const parallelTests = tests.filter((file) => !SERIAL_FIRST_FILES.has(basename(file)));
  const concurrency = Math.min(requestedConcurrency, parallelTests.length || 1);
  const results: UnitResult[] = [];
  const activeChildren = new Set<ChildProcess>();
  let nextTestIndex = 0;
  let interrupted = false;

  await mkdir(logDir, { recursive: true });
  console.log(
    `Running ${tests.length} unit test file(s) with concurrency=${concurrency}` +
      (serialFirst.length > 0 ? ` after ${serialFirst.length} isolated analyzer file(s)...` : '...')
  );

  function stopChildren(signal: NodeJS.Signals): void {
    interrupted = true;
    for (const child of activeChildren) child.kill(signal);
  }

  process.once('SIGINT', () => stopChildren('SIGINT'));
  process.once('SIGTERM', () => stopChildren('SIGTERM'));

  async function runTest(file: string): Promise<UnitResult> {
    const startedAt = performance.now();
    const chunks: Buffer[] = [];
    // Files that drive the database-wide advisory lock get a private database.
    const privateDatabase =
      localDatabaseEnv !== undefined && ISOLATED_DATABASE_FILES.has(basename(file))
        ? createIsolatedDatabase(localDatabaseEnv.DATABASE_URL)
        : undefined;
    // Preserve one isolated process per file without npm/tsx wrapper processes.
    const childEnv = {
      ...process.env,
      ...localDatabaseEnv,
      ...(privateDatabase === undefined
        ? {}
        : { DATABASE_URL: privateDatabase.url, DIRECT_URL: privateDatabase.url }),
    };
    if (SERIAL_FIRST_FILES.has(basename(file))) {
      delete childEnv.NODE_V8_COVERAGE;
    } else if (coverageDir !== undefined) {
      childEnv.NODE_V8_COVERAGE = coverageDir;
    }
    const child = spawn(
      process.execPath,
      ['--experimental-test-module-mocks', '--import', 'tsx', file],
      {
        cwd: backendDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
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
    privateDatabase?.drop();

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
      if (index >= parallelTests.length) return;
      results.push(await runTest(parallelTests[index]));
    }
  }

  for (const file of serialFirst) {
    if (interrupted) break;
    results.push(await runTest(file));
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
