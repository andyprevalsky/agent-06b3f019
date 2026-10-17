/** Exact native poller readiness; missing expected pollers may wait, unknown pollers may not. */
import type { Client } from '@temporalio/client';
import { assertWorkerDeploymentOwned, workerDeploymentQueueName } from './workerDeploymentQueue';

type PollerClient = Pick<Client, 'options' | 'workflowService' | 'withDeadline'>;
export interface WorkerPollerPlan {
  identities: string[];
  machineRecords: Array<{
    id: string;
    instanceId: string;
    configSHA256: string;
    identity: string;
    namespace: string;
  }>;
}
export async function checkWorkerNativePollers(
  client: PollerClient,
  queue: string,
  identities: string[],
  namespace: string
) {
  if (client.options.namespace !== namespace || !namespace)
    throw new Error('Native namespace differs from qualified runtime');
  const observations: string[][] = [];
  for (const taskQueueType of [1, 2]) {
    const reply = await client.withDeadline(Date.now() + 10_000, () =>
      client.workflowService.describeTaskQueue({
        namespace: client.options.namespace,
        taskQueue: { name: queue },
        taskQueueType,
      })
    );
    const seen = new Set<string>();
    for (const poller of reply.pollers ?? []) {
      if (
        typeof poller.identity !== 'string' ||
        !poller.identity ||
        !poller.lastAccessTime?.seconds
      )
        throw new Error('Malformed native poller observation');
      const at = Number(poller.lastAccessTime.seconds) * 1000;
      if (!Number.isFinite(at) || at > Date.now() + 5_000)
        throw new Error('Malformed native poller timestamp');
      if (Date.now() - at > 120_000) continue;
      if (!identities.includes(poller.identity))
        throw new Error('Unexpected native poller identity');
      seen.add(poller.identity);
    }
    observations.push([...seen].sort());
  }
  return {
    ready: observations.every((o) => o.length === 8),
    queue,
    identities,
    workflowPollers: observations[0],
    activityPollers: observations[1],
  };
}
export async function verifyWorkerDeploymentNativePollers(
  jobId: string,
  ownerId: string,
  plan: WorkerPollerPlan
) {
  const job = await assertWorkerDeploymentOwned(jobId, ownerId);
  if (job.ownerId !== ownerId) throw new Error('Deployment controller owner changed');
  if (
    !Array.isArray(plan?.identities) ||
    plan.identities.length !== 8 ||
    new Set(plan.identities).size !== 8 ||
    plan.identities.some((v) => typeof v !== 'string' || !v) ||
    !Array.isArray(plan.machineRecords) ||
    plan.machineRecords.length !== 8 ||
    new Set(plan.machineRecords.map((r) => r.id)).size !== 8 ||
    new Set(plan.machineRecords.map((r) => r.identity)).size !== 8 ||
    plan.machineRecords.some(
      (r) =>
        !job.candidateMachineIds.includes(r.id) ||
        typeof r.instanceId !== 'string' ||
        !r.instanceId ||
        !/^[a-f0-9]{64}$/.test(r.configSHA256) ||
        !plan.identities.includes(r.identity) ||
        typeof r.namespace !== 'string' ||
        !r.namespace
    ) ||
    new Set(plan.machineRecords.map((r) => r.namespace)).size !== 1
  )
    throw new Error('Exact eight native process-to-Machine poller identities required');
  const { getTemporalClient } = await import('./temporal');
  const client = await getTemporalClient();
  const result = await checkWorkerNativePollers(
    client,
    workerDeploymentQueueName(jobId, job.identity.surfaceHash),
    plan.identities,
    plan.machineRecords[0].namespace
  );
  const current = await assertWorkerDeploymentOwned(jobId, ownerId);
  if (current.ownerId !== ownerId) throw new Error('Deployment controller owner changed');
  return result;
}
