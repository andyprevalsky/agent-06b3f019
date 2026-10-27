/** Revalidate admitted AGENT custody after asynchronous connection preparation. */
import { openPhoneValue, sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { setupState } from '../../providers/phoneSetupState';
import { setupDto } from './repo.setup';
import type { Transaction, IPhoneDevice, IPhoneLease } from './types';
import type { CommandClaim, CommandPayload } from './types.operations';
import { databaseNow } from './repo.clock';

export async function executionCustody(
  tx: Transaction,
  claim: CommandClaim,
  device: IPhoneDevice,
  lease: IPhoneLease
): Promise<boolean> {
  if (claim.executionGeneration === undefined) return true;
  const agent = await tx.agent.findUnique({ where: { id: lease.agentId } });
  const state = setupState(device.setupEncrypted);
  const intent = openPhoneValue<CommandPayload>(claim.command.requestEncrypted);
  const generation = agent?.temporalWorkflowId ?? agent?.id;
  const context = intent.setupAttemptId !== undefined || intent.setupRevision !== undefined;
  const current = state.attempt;
  if (
    generation === claim.executionGeneration &&
    ((!context && !setupDto(device, state, lease).required) ||
      (current?.id === intent.setupAttemptId &&
        current?.revision === intent.setupRevision &&
        current?.leaseId === lease.id &&
        current?.taskId === lease.browserTaskId &&
        current?.workflowId === generation))
  )
    return true;
  await tx.iPhoneOperation.updateMany({
    where: { id: claim.command.id, state: 'CONNECTING' },
    data: {
      state: 'FAILED',
      activeDeviceId: null,
      completedAt: await databaseNow(tx),
      errorCode: 'phone_setup_stale',
      resultEncrypted: sealPhoneValue({
        success: false,
        outcome: 'rejected',
        error: 'Phone setup custody changed before execution',
      }),
    },
  });
  return false;
}
