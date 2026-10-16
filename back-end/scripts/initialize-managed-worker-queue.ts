#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { config } from 'dotenv';
import { prisma } from '../src/providers/database';
import { initializeManagedQueue } from '../src/providers/workflowManagedQueue';
config();
async function main() {
  const { values } = parseArgs({
    options: {
      queue: { type: 'string' },
      'surface-hash': { type: 'string' },
      'job-id': { type: 'string' },
      'source-commit': { type: 'string' },
      'owner-id': { type: 'string' },
      'for-retirement': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const queue = values.queue;
  const surfaceHash = values['surface-hash'];
  const jobId = values['job-id'];
  const sourceCommit = values['source-commit'];
  const ownerId = values['owner-id'];
  if (!queue || !surfaceHash || !jobId || !sourceCommit || !ownerId)
    throw new Error('Exact queue, surface-hash, job-id, source-commit and owner-id required');
  await initializeManagedQueue({ queue, surfaceHash, jobId, sourceCommit }, ownerId, {
    forRetirement: values['for-retirement'],
  });
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
