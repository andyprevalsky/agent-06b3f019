/** Coalescing of never-started queued worker deployments into a proven git descendant. */
import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import {
  readPendingWorkerDeployments,
  readWorkerDeployment,
  requireWorkerDeploymentLease,
  workerDeploymentQueueName,
  type WorkerDeploymentJob,
} from './workerDeploymentQueue';

const JOB = 'WORKER_DEPLOYMENT_JOB';
const RESERVATION = 'WORKER_DEPLOYMENT_RESERVATION';
const ANCESTRY = 'WORKER_DEPLOYMENT_ANCESTRY';
const MAX_ANCESTRY_FACTS = 4096;
const MAX_SUPERSEDED_CHAIN = 64;
const json = (value: unknown) => value as Prisma.InputJsonObject;
const jobKey = (jobId: string) => `deployment:worker-job:${jobId}`;
const ancestryKey = (ancestorJobId: string, descendantJobId: string) =>
  `deployment:worker-ancestry:${ancestorJobId}:${descendantJobId}`;

/**
 * Never claimed, prepared, failed or evidenced: no controller has spawned a
 * child for it, so no native action, reservation, retention or pointer exists.
 */
export function isUnstartedWorkerDeployment(job: WorkerDeploymentJob): boolean {
  return (
    job.stage === 'QUEUED' &&
    job.ownerId === null &&
    job.priorPointer === null &&
    job.candidateMachineIds.length === 0 &&
    job.failure === null &&
    Object.keys(job.evidence ?? {}).length === 0
  );
}

export interface WorkerDeploymentAncestryFact {
  ancestorCommit: string;
  descendantCommit: string;
}

/**
 * Pure coalescing plan over the FIFO-ordered pending jobs of one app. Only when
 * the head is unstarted: pick the LAST pending job whose commit is a proven git
 * descendant (or the same commit) of every job ahead of it, and supersede that
 * whole prefix. Started heads, unproven or non-descendant jobs keep plain FIFO.
 */
export function planWorkerDeploymentSupersession(
  queue: WorkerDeploymentJob[],
  facts: WorkerDeploymentAncestryFact[]
): { target: WorkerDeploymentJob; superseded: WorkerDeploymentJob[] } | null {
  if (queue.length < 2 || !isUnstartedWorkerDeployment(queue[0])) return null;
  const app = queue[0].identity.app;
  const edges = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (!edges.has(fact.ancestorCommit)) edges.set(fact.ancestorCommit, new Set());
    edges.get(fact.ancestorCommit)!.add(fact.descendantCommit);
  }
  const reaches = (from: string, to: string) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const commit = stack.pop()!;
      if (commit === to) return true;
      for (const next of edges.get(commit) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
    }
    return false;
  };
  let unstarted = 1;
  while (
    unstarted < queue.length &&
    queue[unstarted].identity.app === app &&
    isUnstartedWorkerDeployment(queue[unstarted])
  )
    unstarted += 1;
  for (let i = unstarted - 1; i >= 1; i -= 1) {
    const target = queue[i];
    const ahead = queue.slice(0, i);
    if (ahead.every((job) => reaches(job.identity.sourceCommit, target.identity.sourceCommit)))
      return { target, superseded: ahead };
  }
  return null;
}

/**
 * Durable, append-only proof that each queued ancestor's commit is contained in
 * the descendant's commit, recorded by the descendant's own controller from its
 * git checkout. A fact only enables coalescing; it grants no native authority.
 */
export async function recordWorkerDeploymentAncestry(
  descendantJobId: string,
  ancestorJobIds: string[],
  proof: string
): Promise<number> {
  if (!ancestorJobIds.length) return 0;
  const descendant = await readWorkerDeployment(descendantJobId);
  const data = [];
  for (const ancestorJobId of ancestorJobIds) {
    const ancestor = await readWorkerDeployment(ancestorJobId);
    if (ancestor.identity.app !== descendant.identity.app)
      throw new Error('Deployment ancestry must stay within one app queue');
    data.push({
      operationKey: ancestryKey(ancestor.jobId, descendant.jobId),
      operationType: ANCESTRY,
      externalId: descendant.identity.app,
      status: 'PROVEN',
      request: json({
        ancestorJobId: ancestor.jobId,
        descendantJobId: descendant.jobId,
        ancestorCommit: ancestor.identity.sourceCommit,
        descendantCommit: descendant.identity.sourceCommit,
        proof: proof.slice(0, 200),
      }),
    });
  }
  const created = await prisma.toolSideEffect.createMany({ data, skipDuplicates: true });
  return created.count;
}

/**
 * Under the global lease and the app FIFO lock, mark the planned unstarted
 * prefix SUPERSEDED by its queued descendant, which becomes the FIFO head.
 * Recomputed from fresh rows on every call, so retries and concurrent enqueues
 * are idempotent: a committed supersession leaves nothing left to plan.
 */
export async function supersedeQueuedWorkerDeployments(
  app: string,
  ownerId: string
): Promise<{ targetJobId: string; supersededJobIds: string[] } | null> {
  return runTransactionWithRetry(async (tx) => {
    await requireWorkerDeploymentLease(tx, ownerId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'deployment:worker-queue:' + app}))`;
    const queue = await readPendingWorkerDeployments(tx, app);
    if (queue.length < 2 || !isUnstartedWorkerDeployment(queue[0])) return null;
    const rows = await tx.toolSideEffect.findMany({
      where: { operationType: ANCESTRY, externalId: app, status: 'PROVEN' },
      select: { request: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_ANCESTRY_FACTS,
    });
    const facts = rows.flatMap(({ request }) => {
      const fact = request as Partial<WorkerDeploymentAncestryFact> | null;
      return typeof fact?.ancestorCommit === 'string' && typeof fact.descendantCommit === 'string'
        ? [{ ancestorCommit: fact.ancestorCommit, descendantCommit: fact.descendantCommit }]
        : [];
    });
    const plan = planWorkerDeploymentSupersession(queue, facts);
    if (!plan) return null;
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    const at = (
      await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    )[0].now.toISOString();
    for (const job of plan.superseded) {
      if (pointer?.taskQueue === workerDeploymentQueueName(job.jobId, job.identity.surfaceHash))
        throw new Error('Cannot supersede a serving deployment');
      const reserved = await tx.toolSideEffect.count({
        where: {
          operationType: RESERVATION,
          externalId: app,
          status: { not: 'RELEASED' },
          request: { path: ['jobId'], equals: job.jobId },
        },
      });
      if (reserved)
        throw new Error('Cannot supersede a deployment that holds Machine reservations');
      const result: WorkerDeploymentJob = {
        ...job,
        stage: 'SUPERSEDED',
        ownerId,
        failure: null,
        evidence: {
          SUPERSEDED: {
            supersededBy: plan.target.jobId,
            sourceCommit: plan.target.identity.sourceCommit,
            surfaceHash: plan.target.identity.surfaceHash,
            attempt: plan.target.identity.attempt,
            proof: 'git-ancestry',
            at,
          },
        },
      };
      const changed = await tx.toolSideEffect.updateMany({
        where: { operationKey: jobKey(job.jobId), operationType: JOB, status: 'QUEUED' },
        data: { status: 'SUPERSEDED', request: json(result), error: null },
      });
      if (changed.count !== 1) throw new Error('Queued deployment changed before supersession');
    }
    return {
      targetJobId: plan.target.jobId,
      supersededJobIds: plan.superseded.map((job) => job.jobId),
    };
  });
}

/** Follow SUPERSEDED links to the job whose cutover carries this release. */
export async function resolveWorkerDeployment(
  jobId: string
): Promise<{ requested: WorkerDeploymentJob; resolved: WorkerDeploymentJob; chain: string[] }> {
  const requested = await readWorkerDeployment(jobId);
  let resolved = requested;
  const chain = [requested.jobId];
  while (resolved.stage === 'SUPERSEDED') {
    const next = (resolved.evidence.SUPERSEDED as { supersededBy?: unknown } | undefined)
      ?.supersededBy;
    if (typeof next !== 'string' || chain.includes(next) || chain.length > MAX_SUPERSEDED_CHAIN)
      throw new Error(`Superseded deployment ${resolved.jobId} has no valid descendant link`);
    resolved = await readWorkerDeployment(next);
    if (resolved.identity.app !== requested.identity.app)
      throw new Error('Superseding deployment belongs to another app queue');
    chain.push(resolved.jobId);
  }
  return { requested, resolved, chain };
}
