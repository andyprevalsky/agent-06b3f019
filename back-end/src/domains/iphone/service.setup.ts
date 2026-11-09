import { observePortrait } from './service.setupPortrait';
import type { PhoneClientFactory } from './types.operations';
import { claimSetup } from './repo.setupCommand';
import { finishSetup, billSetup } from './repo.setupFinish';
import { interaction } from './service.interactions';
import { publicOperation, defaultPhoneClient } from './service.operations';
import type { SetupInput } from '../../providers/phoneSetupState';
import {
  verifyPhoneSetup,
  type SetupVerifier,
  type SetupOutcomeResult,
} from '../../providers/phoneSetupVerifier';
export { configureSetup } from './repo.setupProfile';
export async function submitSetup(
  userId: string,
  taskId: string,
  input: SetupInput,
  verifier: SetupVerifier = verifyPhoneSetup,
  clientFactory?: PhoneClientFactory
) {
  const claim = await claimSetup(userId, taskId, input);
  let command = claim.command;
  if (claim.execute) {
    let result: SetupOutcomeResult | null = null,
      usageRecordId: string | undefined;
    if (input.action === 'verify') {
      try {
        result =
          input.verificationTarget === 'portrait_lock'
            ? await observePortrait(claim, input, clientFactory ?? defaultPhoneClient)
            : await verifier({
                agentId: claim.lease.agentId,
                expectedAppleIdentity: claim.state.expectedAppleIdentity!,
                evidence: claim.evidence,
                verificationTarget: input.verificationTarget,
                expectedReceiveAddress: claim.state.expectedPhone ?? null,
                expectedGoogleIdentity: claim.state.expectedGoogleIdentity,
              });
        if ('usage' in result) {
          const billed = await billSetup(
            claim,
            result,
            input.verificationTarget && input.verificationTarget !== 'apple_account'
              ? `phone_setup_${input.verificationTarget}`
              : 'phone_setup_identity'
          );
          usageRecordId = billed.id;
        }
      } catch {
        result = null;
      }
    }
    command = await finishSetup(claim, input, result, usageRecordId);
  }
  const state = await interaction(userId, taskId, undefined, clientFactory);
  const operation = await publicOperation(command);
  const usage =
    operation.result !== null &&
    operation.result !== undefined &&
    typeof operation.result === 'object' &&
    'usage' in operation.result
      ? operation.result.usage
      : undefined;
  return {
    setup: 'setup' in state ? state.setup : null,
    operation,
    ...(usage !== undefined ? { usage } : {}),
  };
}
