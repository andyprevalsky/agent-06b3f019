#!/usr/bin/env tsx
/** Durable admission fence. Never certifies a legacy cohort from visibility zero. */
import { config } from 'dotenv';
import { prisma } from '../src/providers/database';
import {
  beginQueueRetirement,
  nativeWorkflowTerminal,
  requireQueueRetirementReady,
  queueAdmissionKey,
  type QueueAdmission,
} from '../src/providers/workflowQueueAdmission';
import { getTemporalClient, withTemporalControlDeadline } from '../src/providers/temporal';
config();
const value = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
async function main() {
  if (
    ['--begin', '--retire', '--verify-retired'].filter((flag) => process.argv.includes(flag))
      .length !== 1
  )
    throw new Error('Select exactly one retirement operation');
  const queue = value('--queue');
  const owner = value('--owner');
  if (!queue || (!owner && !process.argv.includes('--verify-retired')))
    throw new Error('Exact queue and retirement owner are required');
  if (process.argv.includes('--begin')) {
    await beginQueueRetirement(queue, owner!);
    return;
  }
  let actualOwner = owner;
  if (process.argv.includes('--verify-retired')) {
    const row = await prisma.toolSideEffect.findUnique({
      where: { operationKey: queueAdmissionKey(queue) },
    });
    const gate = row?.request as unknown as QueueAdmission;
    if (gate?.phase !== 'RETIRED')
      throw new Error('Retained pool source has no durable retirement certificate');
    actualOwner = gate.owner;
  }
  if (!actualOwner) throw new Error('Missing retirement owner');
  const client = await getTemporalClient();
  await requireQueueRetirementReady(queue, actualOwner, async (execution) => {
    const description = await withTemporalControlDeadline(client, () =>
      client.workflow
        .getHandle(execution.workflowId, undefined, {
          firstExecutionRunId: execution.firstExecutionRunId,
        })
        .describe()
    );
    const info = description.raw.workflowExecutionInfo;
    if (!info?.firstRunId || !info.taskQueue)
      throw new Error('Exact native chain/queue reconciliation is incomplete');
    return {
      firstExecutionRunId: info.firstRunId,
      runId: info.execution?.runId ?? undefined,
      queue: info.taskQueue,
      terminal: nativeWorkflowTerminal(description.status.name),
    };
  });
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
