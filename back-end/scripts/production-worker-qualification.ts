#!/usr/bin/env tsx
/** Read-only production evidence: never enqueues, resumes or cuts over. */
import { runReadOnlyTransactionWithRetry, prisma } from '../src/providers/database';
import { decodeWorkerDeploymentJob } from '../src/providers/workerDeploymentQueue';
/** Read-only proof for a workflow that failed before enqueue. Include terminal
 * original jobs too; a missing log line must never conceal a saved job. */
export async function readWorkerDeploymentQualification(app: string, sourceCommit: string) {
  if (!/^[a-z0-9-]+$/.test(app) || !/^[a-f0-9]{40}$/.test(sourceCommit))
    throw new Error('Invalid qualification source/app');
  return runReadOnlyTransactionWithRetry(async (tx) => {
    const rows = await tx.toolSideEffect.findMany({
      where: {
        operationType: 'WORKER_DEPLOYMENT_JOB',
        externalId: app,
        request: { path: ['identity', 'sourceCommit'], equals: sourceCommit },
      },
      take: 2,
    });
    const livePointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    const row = livePointer?.updatedBy
      ? await tx.toolSideEffect.findUnique({
          where: { operationKey: `deployment:worker-job:${livePointer.updatedBy}` },
        })
      : null;
    if (row && row.operationType !== 'WORKER_DEPLOYMENT_JOB')
      throw new Error('Live pointer does not name a deployment job');
    return {
      app,
      sourceCommit,
      originalJobs: rows.map((r) => decodeWorkerDeploymentJob(r.request)),
      livePointer,
      liveJob: row ? decodeWorkerDeploymentJob(row.request) : null,
    };
  });
}

if (require.main === module) {
  const output = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const args = process.argv.slice(2);
  const required = (flag: string) => {
    const index = args.indexOf(flag);
    const value = index < 0 ? undefined : args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} is required`);
    return value;
  };
  Promise.resolve()
    .then(() => readWorkerDeploymentQualification(required('--app'), required('--source')))
    .then((result) => output(JSON.stringify(result) + '\n'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
