/** Explicit trusted configuration fixture for unrelated control cases; first-use cases reset it. */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { setupState, sealSetup } from '../../providers/phoneSetupState';
import { CONFIG_TARGETS, SETUP_REQUIREMENTS_VERSION } from '../../providers/phoneSetupVerification';
export async function syntheticConfiguration(userId: string, leaseId: string) {
  const device = await prisma.iPhoneDevice.findUnique({ where: { userId } });
  if (!device) return;
  const state = setupState(device.setupEncrypted);
  if (state.expectedAppleIdentity !== 'fixture-owner@example.invalid') return;
  const lease = await prisma.iPhoneLease.findUnique({ where: { id: leaseId } });
  if (!lease || lease.userId !== userId) return;
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: lease.agentId } });
  if (!agent.temporalWorkflowId || !agent.temporalFirstExecutionRunId)
    throw new Error('Explicit synthetic configuration requires a published fixture generation');
  let taskId = lease.browserTaskId;
  if (!taskId) {
    // Persist the owned historical producer task; do not bind the current raw lease.
    const context = await prisma.browserContext.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const historicalTask = await prisma.browserSession.create({
      data: { contextId: context.id, agentId: agent.id, sessionId: randomUUID() },
    });
    taskId = historicalTask.id;
  }

  if (
    state.attempt?.leaseId !== lease.id ||
    state.attempt.taskId !== taskId ||
    state.attempt.workflowId !== (agent.temporalWorkflowId ?? agent.id)
  )
    state.attempt = {
      id: randomUUID(),
      revision: 1,
      leaseId: lease.id,
      taskId,
      agentId: lease.agentId,
      workflowId: agent.temporalWorkflowId ?? agent.id,
      firstExecutionRunId: agent.temporalFirstExecutionRunId,
      floorCursor: 0,
      floorAt: new Date().toISOString(),
    };
  state.expectedPhone =
    (await prisma.user.findUniqueOrThrow({ where: { userId } })).phone ?? undefined;
  state.expectedGoogleIdentity ??= 'fixture-google@example.invalid';
  state.verification = {
    requirementsVersion: SETUP_REQUIREMENTS_VERSION,
    checks: Object.fromEntries(
      CONFIG_TARGETS.map((target) => [
        target,
        {
          status: 'confirmed',
          observedAt: new Date().toISOString(),
          evidenceDigest: 'trusted-synthetic-fixture',
          requirementsVersion: SETUP_REQUIREMENTS_VERSION,
          floorCursor: state.attempt.floorCursor,
          attemptId: state.attempt?.id ?? '',
          profileRevision: state.profileRevision,
          workflowId: state.attempt?.workflowId ?? '',
          providerEpoch: device.providerEpoch,
          expectedPhone: state.expectedPhone,
        },
      ])
    ),
  };
  await prisma.iPhoneDevice.update({
    where: { id: device.id },
    data: { setupState: 'ready', setupEncrypted: sealSetup(state) },
  });
  return { setupAttemptId: state.attempt.id, setupRevision: state.attempt.revision };
}

/** Request helpers may echo only already established context; never repair authority. */
export async function syntheticSetupContext(userId: string, leaseId: string) {
  const lease = await prisma.iPhoneLease.findUnique({ where: { id: leaseId } });
  const device = await prisma.iPhoneDevice.findUnique({ where: { userId } });
  if (!lease || lease.userId !== userId || !device) return;
  const state = setupState(device.setupEncrypted);
  if (state.expectedAppleIdentity !== 'fixture-owner@example.invalid') return;
  if (
    lease.browserTaskId === null ||
    state.attempt?.leaseId !== leaseId ||
    state.attempt.taskId !== lease.browserTaskId
  )
    return;
  return { setupAttemptId: state.attempt.id, setupRevision: state.attempt.revision };
}

export async function createSyntheticControlAgent(userId: string) {
  const id = randomUUID();
  return prisma.agent.create({
    data: {
      id,
      userId,
      status: 'ACTIVE',
      goal: 'Synthetic phone control blackbox',
      temporalWorkflowId: id,
      temporalFirstExecutionRunId: randomUUID(),
    },
  });
}
