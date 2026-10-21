import { lockSetupCommit, setupCommitValid } from './repo.setupFence';
import { writeSetupOutcome } from './repo.setupOutcome';
import { setupState, type SetupInput } from '../../providers/phoneSetupState';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { SetupClaim } from './repo.setupCommand';
import type { SetupVerificationResult } from '../../providers/phoneSetupVerifier';
import * as leases from './repo';

export async function billSetup(
  claim: Pick<SetupClaim, 'command' | 'lease'>,
  result: Pick<SetupVerificationResult, 'usage'>,
  toolName = 'phone_setup_identity'
) {
  return leases.transaction((tx) =>
    tx.toolUsage.upsert({
      where: { operationKey: `iphone-setup:${claim.command.id}` },
      create: {
        operationKey: `iphone-setup:${claim.command.id}`,
        userId: claim.lease.userId,
        agentId: claim.lease.agentId,
        toolName,
        totalCostCents: Math.ceil(result.usage.totalCostCents),
        usageItems: [
          {
            type: 'llm',
            call_site: toolName,
            provider: result.usage.model,
            model: result.usage.model,
            tokens_in: result.usage.promptTokens,
            tokens_out: result.usage.completionTokens,
            number_of_tokens: result.usage.totalTokens,
            cost_cents: result.usage.totalCostCents,
          },
        ],
      },
      update: {},
    })
  );
}
export async function finishSetup(
  claim: SetupClaim,
  input: SetupInput,
  result: SetupVerificationResult | null,
  usageRecordId?: string
) {
  return leases.transaction(async (tx) => {
    const device = await lockSetupCommit(tx, claim);
    const command = await tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
    const state = setupState(device.setupEncrypted);
    const valid = await setupCommitValid(tx, device, claim, input, command, state);
    const now = await leases.databaseNow(tx);
    const succeeded = valid && (input.action !== 'verify' || result !== null);
    const errorCode = !valid
      ? 'phone_setup_stale'
      : !succeeded
        ? 'phone_setup_verifier_unavailable'
        : null;
    const usage =
      result !== null && usageRecordId !== undefined
        ? {
            billedBy: 'backend',
            usageRecordId,
            model: result.usage.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalCostCents: result.usage.totalCostCents,
          }
        : undefined;
    if (valid) {
      await writeSetupOutcome(
        tx,
        device,
        state,
        input,
        result,
        now,
        succeeded,
        errorCode,
        claim.evidenceDigest
      );
    }
    await tx.iPhoneOperation.updateMany({
      where: { id: command.id, state: 'RUNNING' },
      data: {
        state: succeeded ? 'SUCCEEDED' : 'FAILED',
        activeDeviceId: null,
        completedAt: now,
        errorCode,
        resultEncrypted: sealPhoneValue({
          success: succeeded,
          ...(usage ? { usage } : {}),
          ...(errorCode !== null ? { error: errorCode } : {}),
        }),
      },
    });
    return tx.iPhoneOperation.findUniqueOrThrow({ where: { id: command.id } });
  });
}
