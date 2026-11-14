/** Called only by the native isolated benchmark bootstrap, before backend/worker start. */
import { open, rename, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDotenvWithCallerOverrides } from '../src/providers/loadDotenvWithCallerOverrides';
import {
  provisionBenchmarkWorldIdentity,
  benchmarkWorldContext,
} from '../src/providers/agentcard/benchmark-world';
import { prisma } from '../src/providers/database';

async function main(): Promise<void> {
  loadDotenvWithCallerOverrides();
  const outputIndex = process.argv.indexOf('--out');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const context = process.env.BENCHMARK_CONTEXT_DIR;
  if (
    !output ||
    !context ||
    !path.isAbsolute(output) ||
    !path.isAbsolute(context) ||
    path.basename(output) !== 'agentcard-world.json' ||
    (await realpath(path.dirname(output))) !== (await realpath(context))
  )
    throw new Error('AgentCard world receipt must be inside the exact native run context');
  const expected = benchmarkWorldContext();
  let previous: Record<string, unknown> | undefined;
  try {
    previous = JSON.parse(await readFile(output, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (previous && (previous.worldId !== expected.worldId || previous.scope !== expected.scope))
    throw new Error(
      'AgentCard world receipt belongs to a different native world/credential/database'
    );
  const identity = await provisionBenchmarkWorldIdentity();
  if (previous && previous.providerUserId !== identity.providerUserId)
    throw new Error('AgentCard world receipt provider identity changed');
  const temporary = `${output}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(identity) + '\n');
  } finally {
    await file.close();
  }
  await rename(temporary, output);
}
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      const record =
        typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
      const code =
        typeof record.code === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(record.code)
          ? record.code
          : undefined;
      process.stderr.write(
        JSON.stringify({
          error: 'AgentCard sandbox world bootstrap failed; no shared fallback',
          type: error instanceof Error ? error.name : 'UnknownError',
          code,
          status: typeof record.status === 'number' ? record.status : undefined,
        }) + '\n'
      );
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
