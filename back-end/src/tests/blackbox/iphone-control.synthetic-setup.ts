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
  if (!lease.browserTaskId) {
    const context = await prisma.browserContext.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const task = await prisma.browserSession.create({
      data: { contextId: context.id, agentId: lease.agentId, sessionId: randomUUID() },
    });
    lease.browserTaskId = task.id;
    await prisma.iPhoneLease.update({ where: { id: lease.id }, data: { browserTaskId: task.id } });
  }
  if (
    state.attempt?.leaseId !== lease.id ||
    state.attempt.taskId !== lease.browserTaskId ||
    state.attempt.workflowId !== (agent.temporalWorkflowId ?? agent.id)
  )
    state.attempt = {
      id: randomUUID(),
      revision: 1,
      leaseId: lease.id,
      taskId: lease.browserTaskId,
      agentId: lease.agentId,
      workflowId: agent.temporalWorkflowId ?? agent.id,
      floorCursor: 0,
      floorAt: new Date().toISOString(),
    };
  state.expectedPhone = '+19729777432';
  state.expectedGoogleIdentity ??= 'fixture-google@example.invalid';
  if (state.verification === undefined)
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
    data: { setupEncrypted: sealSetup(state) },
  });
  return { setupAttemptId: state.attempt.id, setupRevision: state.attempt.revision };
}
