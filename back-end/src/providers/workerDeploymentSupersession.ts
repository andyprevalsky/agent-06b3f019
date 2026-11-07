/** Coalescing of never-started queued worker deployments into a proven git descendant. */
import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import {
  decodeWorkerDeploymentJob,
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
const MAX_LIVE_CANDIDATES = 64;
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

/** True when `ancestor` equals `descendant` or a chain of proven facts links them. */
export function commitContains(
  facts: WorkerDeploymentAncestryFact[],
  ancestor: string,
  descendant: string
): boolean {
  const seen = new Set([ancestor]);
  const stack = [ancestor];
  while (stack.length) {
    const commit = stack.pop()!;
    if (commit === descendant) return true;
    for (const fact of facts)
      if (fact.ancestorCommit === commit && !seen.has(fact.descendantCommit)) {
        seen.add(fact.descendantCommit);
        stack.push(fact.descendantCommit);
      }
  }
  return false;
}

/**
 * How an unstarted head relates to the live (serving) release: `forward` when
 * the live commit is contained in it (a normal deploy), `contained` when the
 * head is an older commit the live release already carries, otherwise
 * `unproven` (diverged, or no proof): cutting over could roll production back.
 */
export function liveWorkerDeploymentRelation(
  head: WorkerDeploymentJob,
  live: WorkerDeploymentJob,
  facts: WorkerDeploymentAncestryFact[]
): 'forward' | 'contained' | 'unproven' {
  if (commitContains(facts, live.identity.sourceCommit, head.identity.sourceCommit))
    return 'forward';
  if (commitContains(facts, head.identity.sourceCommit, live.identity.sourceCommit))
    return 'contained';
  return 'unproven';
}

/** The SUCCEEDED job of this app whose managed queue the singleton pointer serves. */
async function liveJob(
  tx: Pick<Prisma.TransactionClient, 'toolSideEffect' | 'agentQueuePointer'>,
  app: string
): Promise<WorkerDeploymentJob | null> {
  const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
  if (!pointer) return null;
  const rows = await tx.toolSideEffect.findMany({
    where: { operationType: JOB, externalId: app, status: 'SUCCEEDED' },
    orderBy: [{ createdAt: 'desc' }, { operationKey: 'desc' }],
    take: MAX_LIVE_CANDIDATES,
  });
  for (const row of rows) {
    const job = decodeWorkerDeploymentJob(row.request);
    if (
      pointer.surfaceHash === job.identity.surfaceHash &&
      pointer.taskQueue === workerDeploymentQueueName(job.jobId, job.identity.surfaceHash)
    )
      return job;
  }
  return null;
}
export async function readWorkerDeploymentLive(app: string): Promise<WorkerDeploymentJob | null> {
  return liveJob(prisma, app);
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
  const reaches = (from: string, to: string) => commitContains(facts, from, to);
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

export interface WorkerDeploymentAdmission {
  targetJobId: string | null;
  supersededJobIds: string[];
  refusedJobIds: string[];
  liveJobId: string | null;
}

/**
 * Under the global lease and the app FIFO lock, only for UNSTARTED heads:
 * 1. coalesce the unstarted prefix into its last proven queued descendant;
 * 2. never roll back: a head the live release already contains is SUPERSEDED by
 *    the live job; a head not proven to contain the live commit is ABORTED with
 *    reason ROLLBACK_REFUSED. A forward head (or any started head) is untouched.
 * Recomputed from fresh rows on every call, so retries and concurrent enqueues
 * are idempotent: a committed admission leaves nothing left to change.
 */
export async function supersedeQueuedWorkerDeployments(
  app: string,
  ownerId: string
): Promise<WorkerDeploymentAdmission | null> {
  return runTransactionWithRetry(async (tx) => {
    await requireWorkerDeploymentLease(tx, ownerId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'deployment:worker-queue:' + app}))`;
    let queue = await readPendingWorkerDeployments(tx, app);
    if (!queue.length || !isUnstartedWorkerDeployment(queue[0])) return null;
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
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    const at = (
      await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
    )[0].now.toISOString();
    const finish = async (
      job: WorkerDeploymentJob,
      stage: 'SUPERSEDED' | 'ABORTED',
      evidence: Record<string, Prisma.JsonValue>
    ) => {
      if (pointer?.taskQueue === workerDeploymentQueueName(job.jobId, job.identity.surfaceHash))
        throw new Error('Cannot supersede or refuse a serving deployment');
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
        stage,
        ownerId,
        failure: null,
        evidence: { [stage]: { ...evidence, at } },
      };
      const changed = await tx.toolSideEffect.updateMany({
        where: { operationKey: jobKey(job.jobId), operationType: JOB, status: 'QUEUED' },
        data: { status: stage, request: json(result), error: null },
      });
      if (changed.count !== 1) throw new Error('Queued deployment changed before supersession');
    };
    const carriedBy = (target: WorkerDeploymentJob, basis: string) => ({
      supersededBy: target.jobId,
      sourceCommit: target.identity.sourceCommit,
      surfaceHash: target.identity.surfaceHash,
      attempt: target.identity.attempt,
      proof: 'git-ancestry',
      basis,
    });
    const admission: WorkerDeploymentAdmission = {
      targetJobId: null,
      supersededJobIds: [],
      refusedJobIds: [],
      liveJobId: null,
    };
    const plan = planWorkerDeploymentSupersession(queue, facts);
    if (plan) {
      for (const job of plan.superseded)
        await finish(job, 'SUPERSEDED', carriedBy(plan.target, 'queued-descendant'));
      admission.targetJobId = plan.target.jobId;
      admission.supersededJobIds.push(...plan.superseded.map((job) => job.jobId));
      queue = queue.slice(plan.superseded.length);
    }
    const live = await liveJob(tx, app);
    admission.liveJobId = live?.jobId ?? null;
    while (live && queue.length && isUnstartedWorkerDeployment(queue[0])) {
      const head = queue.shift()!;
      const relation = liveWorkerDeploymentRelation(head, live, facts);
      if (relation === 'forward') break;
      if (relation === 'contained') {
        await finish(head, 'SUPERSEDED', carriedBy(live, 'live-descendant'));
        admission.supersededJobIds.push(head.jobId);
        admission.targetJobId = live.jobId;
        continue;
      }
      await finish(head, 'ABORTED', {
        reason: 'ROLLBACK_REFUSED',
        liveJobId: live.jobId,
        liveCommit: live.identity.sourceCommit,
        headCommit: head.identity.sourceCommit,
        message: `Refused: ${head.identity.sourceCommit} is not proven to contain live ${live.identity.sourceCommit}; cutting over could roll production back`,
      });
      admission.refusedJobIds.push(head.jobId);
    }
    return admission.supersededJobIds.length || admission.refusedJobIds.length ? admission : null;
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
