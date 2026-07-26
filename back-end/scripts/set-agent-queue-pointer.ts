#!/usr/bin/env tsx
/**
 * Flip (or read) the current agent-queue pointer — the atomic step of the
 * zero-downtime cutover. The deploy runs this AFTER the new-generation workers
 * are confirmed live, so new agent workflows immediately route to the new
 * generation queue. It is also the fail-safe rollback: flipping back to the
 * previous generation restores routing instantly with no redeploy.
 *
 * Usage:
 *   set-agent-queue-pointer.ts --queue navi-agent-tasks@<hash> --surface-hash <hash> [--by <ctx>]
 *   set-agent-queue-pointer.ts --read      # print current pointer as JSON (or "null")
 *
 * DATABASE_URL must point at the target (prod in CI). Exits non-zero on bad args
 * or DB failure — never silently.
 */
import { config } from 'dotenv';
import { readAgentQueuePointer, setCurrentAgentQueue } from '../src/providers/agentQueuePointer';
import { prisma } from '../src/providers/database';

config();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--read')) {
    const row = await readAgentQueuePointer();
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }

  const queue = argValue('--queue');
  const surfaceHash = argValue('--surface-hash');
  const updatedBy = argValue('--by');
  if (!queue || !surfaceHash) {
    process.stderr.write(
      'Usage: set-agent-queue-pointer.ts --queue <name> --surface-hash <hash> [--by <ctx>]\n' +
        '   or: set-agent-queue-pointer.ts --read\n'
    );
    process.exit(2);
  }
  const expectedSuffix = `@${surfaceHash}`;
  if (!queue.endsWith(expectedSuffix)) {
    // Guard against pointing at a queue whose generation does not match the hash
    // we recorded — that mismatch would let workers and the router disagree.
    process.stderr.write(
      `Refusing to flip: queue ${queue} does not end with generation ${expectedSuffix}\n`
    );
    process.exit(2);
  }
  await setCurrentAgentQueue(queue, surfaceHash, updatedBy);
  const row = await readAgentQueuePointer();
  process.stdout.write(`Agent queue pointer set: ${JSON.stringify(row)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
