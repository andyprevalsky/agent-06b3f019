import { CONTINUATION_OPERATION, type ContinuationTicket } from './workflowQueueContinuation';
import { claimPhysicalRootStart, type RootTerminalWitness } from './workflowPhysicalStart';
import { managedQueue } from './workflowManagedQueue';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from './database';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import type { TemporalWorkflowExecutionRef } from './temporal';

const ROUTING_LOCK = 'agent-queue-admission';
export const QUEUE_ADMISSION_OPERATION = 'AGENT_QUEUE_ADMISSION';
export const START_ADMISSION_OPERATION = 'AGENT_QUEUE_START';
export const queueAdmissionKey = (queue: string) => `agent-queue-admission:${queue}`;
export const startAdmissionKey = (id: string) => `agent-queue-start:${id}`;
export type AdmissionTransaction = typeof runTransactionWithRetry;
export interface QueueAdmission {
  version: 1;
  queue: string;
  incarnation: string;
  phase: 'OPEN' | 'RETIRING' | 'RETIRED';
  owner: string;
  surfaceHash?: string;
  legacyCoverage: 'UNKNOWN' | 'QUALIFIED';
  legacyCertificate?: { producerTransition: string; cohortManifest: string; unresolved: number };
}
export interface StartAdmission {
  version: 1;
  id: string;
  agentId: string;
  workflowId: string;
  requestedQueue: string;
  queue: string;
  incarnation: string;
  rejectDuplicate: boolean;
  accepted?: TemporalWorkflowExecutionRef;
  wireCoverage: 'UNKNOWN' | 'IMMUTABLE_ID';
}
export class WorkflowStartAdmissionPendingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
const pendingErrors = new WeakSet<object>();
export function retainPendingWorkflowStart(error: unknown): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function')
    pendingErrors.add(error);
}
export function isWorkflowStartAdmissionPending(error: unknown): boolean {
  return (
    error instanceof WorkflowStartAdmissionPendingError ||
    (typeof error === 'object' && error !== null && pendingErrors.has(error))
  );
}
function queueState(value: unknown, queue: string): QueueAdmission {
  const state = value as QueueAdmission;
  if (
    state?.version !== 1 ||
    state.queue !== queue ||
    !state.incarnation ||
    !state.owner ||
    !['OPEN', 'RETIRING', 'RETIRED'].includes(state.phase) ||
    !['UNKNOWN', 'QUALIFIED'].includes(state.legacyCoverage)
  )
    throw new WorkflowStartAdmissionPendingError('Queue admission state is unqualified');
  return state;
}
async function shared(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${ROUTING_LOCK}))`;
}
export async function lockQueueAdmission(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ROUTING_LOCK}))`;
}
export async function claimWorkflowStart(
  agentId: string,
  workflowId: string,
  requestedQueue: string,
  rejectDuplicate: boolean,
  deadlineAtMs: number,
  transaction: AdmissionTransaction = runTransactionWithRetry,
  fingerprint = '',
  terminalWitnesses?: ReadonlyMap<string, RootTerminalWitness>
): Promise<StartAdmission> {
  return transaction(
    async (tx) => {
      await shared(tx);
      await lockAgentWorkflowGeneration(tx, agentId);
      const found = await tx.toolSideEffect.findUnique({
        where: { operationKey: queueAdmissionKey(requestedQueue) },
      });
      let gate = found === null ? undefined : queueState(found.request, requestedQueue);
      let queue = requestedQueue;
      if (gate !== undefined && gate.phase !== 'OPEN') {
        // Cache and explicit overrides cannot authorize a closed destination.
        const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
        const target =
          pointer &&
          (await tx.toolSideEffect.findUnique({
            where: { operationKey: queueAdmissionKey(pointer.taskQueue) },
          }));
        if (!pointer || !pointer.surfaceHash || !target || pointer.taskQueue === requestedQueue)
          throw new WorkflowStartAdmissionPendingError(
            'No verified open destination for workflow start'
          );
        gate = queueState(target.request, pointer.taskQueue);
        if (gate.phase !== 'OPEN' || gate.surfaceHash !== pointer.surfaceHash)
          throw new WorkflowStartAdmissionPendingError('Current destination is not verified open');
        queue = pointer.taskQueue;
      }
      if (managedQueue(queue)) {
        const current = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
        if (
          !gate ||
          gate.phase !== 'OPEN' ||
          gate.legacyCoverage !== 'QUALIFIED' ||
          current?.taskQueue !== queue ||
          current.surfaceHash !== gate.surfaceHash
        )
          throw new WorkflowStartAdmissionPendingError(
            'Managed queue is not the published qualified destination'
          );
      }
      let admittedWorkflowId = workflowId;
      let immutable = rejectDuplicate;
      if (managedQueue(queue) && !immutable) {
        admittedWorkflowId = await claimPhysicalRootStart(
          tx,
          agentId,
          fingerprint,
          terminalWitnesses
        );
        immutable = true;
      }
      const intent: StartAdmission = {
        version: 1,
        id: randomUUID(),
        agentId,
        workflowId: admittedWorkflowId,
        requestedQueue,
        queue,
        incarnation: gate?.incarnation ?? 'legacy-unqualified',
        rejectDuplicate: immutable,
        // ALLOW_DUPLICATE cannot be certified by a later ACK alone: a prior wire
        // attempt may still reopen a closed chain. Keep that uncertainty explicit.
        wireCoverage: immutable ? 'IMMUTABLE_ID' : 'UNKNOWN',
      };
      await tx.toolSideEffect.create({
        data: {
          operationKey: startAdmissionKey(intent.id),
          operationType: START_ADMISSION_OPERATION,
          status: 'STARTED',
          externalId: agentId,
          request: intent as unknown as Prisma.InputJsonObject,
        },
      });
      return intent;
    },
    { deadlineAtMs }
  );
}
export async function acknowledgeWorkflowStart(
  intent: StartAdmission,
  execution: TemporalWorkflowExecutionRef,
  deadlineAtMs: number,
  transaction: AdmissionTransaction = runTransactionWithRetry
): Promise<void> {
  await transaction(
    async (tx) => {
      await lockAgentWorkflowGeneration(tx, intent.agentId);
      const row = await tx.toolSideEffect.findUnique({
        where: { operationKey: startAdmissionKey(intent.id) },
      });
      if (row === null)
        throw new WorkflowStartAdmissionPendingError('Workflow admission membership was lost');
      const saved = row.request as unknown as StartAdmission;
      if (
        saved.id !== intent.id ||
        saved.workflowId !== execution.workflowId ||
        !execution.firstExecutionRunId
      )
        throw new WorkflowStartAdmissionPendingError(
          'Native acknowledgement does not match admission'
        );
      await tx.toolSideEffect.update({
        where: { operationKey: startAdmissionKey(intent.id) },
        data: {
          status: 'COMPLETED',
          request: { ...saved, accepted: execution } as unknown as Prisma.InputJsonObject,
        },
      });
    },
    { deadlineAtMs }
  );
}
export async function beginQueueRetirement(
  queue: string,
  owner: string,
  transaction: AdmissionTransaction = runTransactionWithRetry
): Promise<QueueAdmission> {
  return transaction(async (tx) => {
    await lockQueueAdmission(tx);
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (pointer === null || pointer.taskQueue === queue)
      throw new WorkflowStartAdmissionPendingError('Current live queue cannot be retired');
    const row = await tx.toolSideEffect.findUnique({
      where: { operationKey: queueAdmissionKey(queue) },
    });
    const prior = row === null ? undefined : queueState(row.request, queue);
    if (prior && prior.phase !== 'OPEN' && prior.owner !== owner)
      throw new WorkflowStartAdmissionPendingError('Queue retirement belongs to another owner');
    const state: QueueAdmission = {
      version: 1,
      queue,
      owner,
      incarnation: prior?.incarnation ?? randomUUID(),
      phase: prior?.phase === 'RETIRED' ? 'RETIRED' : 'RETIRING',
      legacyCoverage: prior?.legacyCoverage ?? 'UNKNOWN',
      ...(prior?.surfaceHash ? { surfaceHash: prior.surfaceHash } : {}),
      ...(prior?.legacyCertificate ? { legacyCertificate: prior.legacyCertificate } : {}),
    };
    await tx.toolSideEffect.upsert({
      where: { operationKey: queueAdmissionKey(queue) },
      create: {
        operationKey: queueAdmissionKey(queue),
        operationType: QUEUE_ADMISSION_OPERATION,
        status: state.phase,
        externalId: queue,
        request: state as unknown as Prisma.InputJsonObject,
      },
      update: { status: state.phase, request: state as unknown as Prisma.InputJsonObject },
    });
    return state;
  });
}
export async function requireQueueRetirementReady(
  queue: string,
  owner: string,
  reconcile: (
    execution: TemporalWorkflowExecutionRef
  ) => Promise<{ firstExecutionRunId: string; queue: string; terminal: boolean; runId?: string }>,
  transaction: AdmissionTransaction = runTransactionWithRetry
): Promise<void> {
  const snapshot = await transaction(async (tx) => {
    await lockQueueAdmission(tx);
    const row = await tx.toolSideEffect.findUnique({
      where: { operationKey: queueAdmissionKey(queue) },
    });
    const gate = queueState(row?.request, queue);
    if (gate.owner !== owner || gate.phase === 'OPEN')
      throw new WorkflowStartAdmissionPendingError('Queue retirement owner is not current');
    const certificate = gate.legacyCertificate;
    if (
      gate.legacyCoverage !== 'QUALIFIED' ||
      !certificate?.producerTransition ||
      !certificate.cohortManifest ||
      certificate.unresolved !== 0
    )
      throw new WorkflowStartAdmissionPendingError('Legacy producer/start coverage is unqualified');
    const rows = await tx.toolSideEffect.findMany({
      where: {
        operationType: START_ADMISSION_OPERATION,
        request: { path: ['queue'], equals: queue },
      },
    });
    for (const row of rows) {
      const intent = row.request as unknown as StartAdmission;
      if (row.status !== 'COMPLETED' || !intent.accepted || intent.wireCoverage !== 'IMMUTABLE_ID')
        throw new WorkflowStartAdmissionPendingError(
          'Source start or native wire outcome remains unresolved'
        );
    }
    const tickets = await tx.toolSideEffect.findMany({
      where: { operationType: CONTINUATION_OPERATION, request: { path: ['queue'], equals: queue } },
    });
    return { gate, rows, tickets };
  });
  // Native reconciliation runs outside every transaction/advisory lock.
  for (const row of snapshot.rows) {
    const intent = row.request as unknown as StartAdmission;
    const current = await reconcile(intent.accepted!);
    if (
      current.firstExecutionRunId !== intent.accepted!.firstExecutionRunId ||
      typeof current.queue !== 'string' ||
      current.queue.length === 0 ||
      typeof current.terminal !== 'boolean' ||
      (!current.terminal && current.queue === queue)
    )
      throw new WorkflowStartAdmissionPendingError(
        'Accepted native chain still needs the source queue'
      );
  }
  for (const row of snapshot.tickets) {
    const ticket = row.request as unknown as ContinuationTicket;
    const current = await reconcile({
      workflowId: ticket.workflowId,
      firstExecutionRunId: ticket.firstExecutionRunId,
    });
    if (
      ticket.incarnation !== snapshot.gate.incarnation ||
      typeof ticket.workflowId !== 'string' ||
      typeof ticket.runId !== 'string' ||
      typeof current.terminal !== 'boolean' ||
      typeof current.queue !== 'string' ||
      current.queue.length === 0 ||
      !current.runId ||
      current.firstExecutionRunId !== ticket.firstExecutionRunId ||
      (!current.terminal && (current.runId === ticket.runId || current.queue === queue))
    )
      throw new WorkflowStartAdmissionPendingError(
        'Continuation source or destination chain remains unresolved'
      );
  }
  await transaction(async (tx) => {
    await lockQueueAdmission(tx);
    const gate = queueState(
      (await tx.toolSideEffect.findUnique({ where: { operationKey: queueAdmissionKey(queue) } }))
        ?.request,
      queue
    );
    const rows = await tx.toolSideEffect.findMany({
      where: {
        operationType: START_ADMISSION_OPERATION,
        request: { path: ['queue'], equals: queue },
      },
    });
    const tickets = await tx.toolSideEffect.findMany({
      where: { operationType: CONTINUATION_OPERATION, request: { path: ['queue'], equals: queue } },
    });
    const pointer = await tx.agentQueuePointer.findUnique({ where: { id: 'singleton' } });
    if (
      JSON.stringify(tickets.map((row) => [row.operationKey, row.status, row.request]).sort()) !==
        JSON.stringify(
          snapshot.tickets.map((row) => [row.operationKey, row.status, row.request]).sort()
        ) ||
      !pointer ||
      pointer.taskQueue === queue ||
      gate.owner !== owner ||
      gate.incarnation !== snapshot.gate.incarnation ||
      JSON.stringify(gate) !== JSON.stringify(snapshot.gate) ||
      gate.phase === 'OPEN' ||
      JSON.stringify(rows.map((row) => [row.operationKey, row.status, row.request]).sort()) !==
        JSON.stringify(
          snapshot.rows.map((row) => [row.operationKey, row.status, row.request]).sort()
        )
    )
      throw new WorkflowStartAdmissionPendingError(
        'Queue membership changed during reconciliation'
      );
    // This durable tombstone, not visibility indexing, excludes late starts.
    await tx.toolSideEffect.update({
      where: { operationKey: queueAdmissionKey(queue) },
      data: {
        status: 'RETIRED',
        request: { ...gate, phase: 'RETIRED' } as unknown as Prisma.InputJsonObject,
      },
    });
  });
}

export function nativeWorkflowTerminal(status: string): boolean {
  if (['COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT'].includes(status)) return true;
  if (['RUNNING', 'CONTINUED_AS_NEW'].includes(status)) return false;
  throw new WorkflowStartAdmissionPendingError('Native workflow status is unknown');
}
