/** Durable admission and its server-only execution-generation snapshot. */
import type { Transaction, IPhoneDevice, IPhoneLease } from './types';
import type { PhoneCommand, PhoneActor, CommandClaim } from './types.operations';
import { databaseNow } from './repo.clock';
interface Admission {
  device: IPhoneDevice;
  lease: IPhoneLease;
  input: PhoneCommand;
  actor: PhoneActor;
  inputHash: string;
  requestEncrypted: string;
  observation: boolean;
  taskBound: boolean;
  ownsSlot: boolean;
}
export async function createCommandJournal(
  tx: Transaction,
  admission: Admission
): Promise<CommandClaim> {
  const {
    device,
    lease,
    input,
    actor,
    inputHash,
    requestEncrypted,
    observation,
    taskBound,
    ownsSlot,
  } = admission;
  const leaseId = lease.id;
  const now = await databaseNow(tx);
  const command = await tx.iPhoneOperation.create({
    data: {
      deviceId: device.id,
      leaseId,
      requestKey: input.operationId,
      operation: input.operation,
      actor,
      inputHash,
      cursor: lease.actionCursor + (observation ? 0 : 1),
      requestEncrypted,
      activeDeviceId: ownsSlot ? device.id : null,
      providerEpoch: device.providerEpoch,
      deadlineAt: new Date(now.getTime() + 300_000),
    },
  });
  if (!observation)
    await tx.iPhoneLease.update({
      where: { id: leaseId },
      data: { actionCursor: { increment: 1 }, lastOperationId: command.id },
    });
  const agent =
    !observation && actor === 'agent'
      ? await tx.agent.findUniqueOrThrow({ where: { id: lease.agentId } })
      : null;
  return {
    device,
    lease,
    command,
    execute: true,
    taskBound,
    ...(agent ? { executionGeneration: agent.temporalWorkflowId ?? agent.id } : {}),
  };
}
