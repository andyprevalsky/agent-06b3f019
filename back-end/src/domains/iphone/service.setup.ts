import { observePortrait } from './service.setupPortrait';
import type { PhoneClientFactory } from './types.operations';
import { claimSetup } from './repo.setupCommand';
import { finishSetup, billSetup } from './repo.setupFinish';
import { interaction } from './service.interactions';
import { publicOperation, defaultPhoneClient } from './service.operations';
import type { SetupInput } from '../../providers/phoneSetupState';
import { createLogger } from '../../providers/logger';
import { IPhoneError } from './types';
import {
  verifyPhoneSetup,
  type SetupVerifier,
  type SetupOutcomeResult,
} from '../../providers/phoneSetupVerifier';
export { configureSetup } from './repo.setupProfile';
const log = createLogger('iPhoneSetup');
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
      usageRecordId: string | undefined,
      failureCode: string | undefined,
      failureDetail: Record<string, unknown> | undefined;
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
      } catch (error) {
        result = null;
        // A typed precondition is actionable for the agent; anything else stays a verifier outage.
        failureCode =
          error instanceof IPhoneError && error.code !== undefined ? error.code : undefined;
        failureDetail = error instanceof IPhoneError ? error.detail : undefined;
        log.warn('verify failed', {
          operationId: claim.command.id,
          leaseId: claim.lease.id,
          agentId: claim.lease.agentId,
          target: input.verificationTarget ?? 'apple_account',
          code: failureCode ?? 'phone_setup_verifier_unavailable',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          ...(failureDetail?.portraitRoute !== undefined
            ? { portraitRoute: failureDetail.portraitRoute }
            : {}),
        });
      }
    }
    command = await finishSetup(claim, input, result, usageRecordId, failureCode, failureDetail);
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
