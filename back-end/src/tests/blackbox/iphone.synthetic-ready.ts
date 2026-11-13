import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { syntheticConfiguration } from './iphone-control.synthetic-setup';
import { setupState, sealSetup } from '../../providers/phoneSetupState';
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
/** Explicit completed bootup fixture for the two positive browser-binding cases only.
 * Never called by request/acquire helpers and refuses to heal a changed profile. */
export async function completedSyntheticSetup(
  f: { userId: string; device: { id: string } },
  producerId: string,
  acquire: (userId: string, agentId: string) => Promise<{ id: string }>,
  action: (userId: string, leaseId: string, operation: string) => Promise<{ status: number }>
) {
  const initial = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.device.id } });
  assert(
    initial.setupEncrypted === null && initial.setupState === 'not_started',
    'Ready fixture requires a fresh unconfigured device'
  );
  const producer = await prisma.agent.findUniqueOrThrow({ where: { id: producerId } });
  assert(producer.userId === f.userId, 'Synthetic setup producer belongs to another account');
  const workflowId = producer.temporalWorkflowId ?? producer.id;
  const firstRun = producer.temporalFirstExecutionRunId ?? randomUUID();
  await prisma.agent.update({
    where: { id: producer.id },
    data: { temporalWorkflowId: workflowId, temporalFirstExecutionRunId: firstRun },
  });
  const setupLease = await acquire(f.userId, producer.id);
  await prisma.iPhoneDevice.update({
    where: { id: initial.id },
    data: {
      setupEncrypted: sealSetup({
        version: 1,
        profileRevision: 1,
        claimRevision: 1,
        expectedAppleIdentity: 'fixture-owner@example.invalid',
        verified: { at: new Date().toISOString(), profileRevision: 1 },
      }),
    },
  });
  await syntheticConfiguration(f.userId, setupLease.id);
  const configured = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: initial.id } });
  const state = setupState(configured.setupEncrypted);
  assert(
    state.attempt !== undefined && state.verification !== undefined,
    'Synthetic setup must have all current configuration proofs'
  );
  assert(
    state.attempt.firstExecutionRunId === firstRun,
    'Synthetic setup must bind the real first run'
  );
  await prisma.iPhoneDevice.update({
    where: { id: initial.id },
    data: { setupState: 'ready', setupEncrypted: sealSetup(state) },
  });
  const released = await action(f.userId, setupLease.id, 'release');
  assert(released.status === 200, 'Synthetic setup release must complete');
}
