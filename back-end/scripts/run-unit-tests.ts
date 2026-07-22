import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

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
