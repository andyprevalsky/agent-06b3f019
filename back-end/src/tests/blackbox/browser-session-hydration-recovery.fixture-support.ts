import assert from 'node:assert/strict';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { assertLifecycleState } from './browser-session-state.fixture-support';

interface HydrationFixture {
  taskId: string;
  origin: string;
  creates(): number;
  resume(): Promise<{ session_id: string }>;
  pause(id: string): Promise<unknown>;
  natives: ReadonlyMap<string, Browser>;
  released: readonly string[];
  setFaults(faults: { navigation?: boolean; storage?: boolean; release?: boolean }): void;
}

export async function assertHydrationRecovery({
  taskId,
  origin,
  creates,
  resume,
  pause,
  natives,
  released,
  setFaults,
}: HydrationFixture): Promise<void> {
  // Incident 2026-10-28 (agent 1ffdb87d, agent-payment-setup-resume): the
  // checkpoint storage was already written into the candidate when the saved
  // tab's page.goto timed out inside the owning request. A failure the owner
  // itself observed is not an unknown outcome: the exact candidate is released,
  // custody reopens, and the next resume materializes the untouched checkpoint
  // at once instead of answering `Browser resume is still in progress` for the
  // remaining 35-minute lease (which bricked every later browser spawn).
  const beforeLateFailure = await prisma.browserSession.findUniqueOrThrow({
    where: { id: taskId },
  });
  const createsBeforeLateFailure = creates();
  setFaults({ navigation: true });
  await assert.rejects(resume(), /fixture navigation failed/);
  setFaults({ navigation: false });
  assert.equal(creates(), createsBeforeLateFailure + 1, 'late failure allocated one candidate');
  const abandoned = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: `steel-browser-task-lifecycle:${taskId}` },
  });
  assert.equal(abandoned.status, 'RELEASED', 'owner-observed hydration failure reopens custody');
  const abandonedResponse = abandoned.response as Record<string, unknown>;
  assert.equal(abandonedResponse.phase, 'rejected');
  const failedCandidate = abandonedResponse.abandoned;
  assert(typeof failedCandidate === 'string' && failedCandidate !== '');
  assert.notEqual(
    failedCandidate,
    beforeLateFailure.sessionId,
    'only the replacement candidate is released, never the source'
  );
  assert(released.includes(failedCandidate), 'failed hydration candidate must be released');
  assert(!natives.has(failedCandidate), 'released candidate must not stay live');
  const afterLateFailure = await prisma.browserSession.findUniqueOrThrow({
    where: { id: taskId },
  });
  assert.equal(afterLateFailure.status, 'PAUSED', 'failed hydration must never publish ACTIVE');
  assert.equal(
    afterLateFailure.checkpointRef,
    beforeLateFailure.checkpointRef,
    'the saved checkpoint survives a failed restore'
  );
  const recovered = await resume();
  assert.equal(creates(), createsBeforeLateFailure + 2, 'recovery allocates a fresh candidate');
  assert.notEqual(recovered.session_id, failedCandidate);
  assert.equal(
    (await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } })).status,
    'ACTIVE'
  );
  await assertLifecycleState(natives.get(recovered.session_id)!, origin);
  await pause(recovered.session_id);
  // An unconfirmable release keeps the failed candidate fenced exactly as a
  // crashed owner would: custody stays STARTED and expiry stays unknown.
  setFaults({ storage: true });
  setFaults({ release: true });
  await assert.rejects(resume(), /fixture hydration failed/);
  setFaults({ storage: false });
  setFaults({ release: false });
  const pending = await prisma.toolSideEffect.findUniqueOrThrow({
    where: { operationKey: `steel-browser-task-lifecycle:${taskId}` },
  });
  assert.equal(pending.status, 'STARTED', 'unconfirmed candidate release keeps custody');
  assert.equal(
    (await prisma.browserSession.findUniqueOrThrow({ where: { id: taskId } })).status,
    'PAUSED',
    'partial hydration must never publish ACTIVE'
  );
  const request = pending.request as Record<string, unknown>;
  await prisma.toolSideEffect.update({
    where: { id: pending.id },
    data: { request: { ...request, expiresAt: new Date(0).toISOString() } },
  });
  const countBeforeUnknown = creates();
  await assert.rejects(resume(), /hydration outcome remains unknown/);
  assert.equal(creates(), countBeforeUnknown, 'unknown hydration must not be replaced');
}
