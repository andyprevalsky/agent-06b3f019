import { IPhoneError, type IPhoneDevice } from './types';
import * as leases from './repo';
import {
  setupState,
  sealSetup,
  SETUP_OPERATIONS,
  type SetupState,
} from '../../providers/phoneSetupState';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { isNativePhoneAttention } from '../../providers/nativePhoneAttention';

export async function configureSetup(
  userId: string,
  expectedRevision: number,
  identity: string,
  googleIdentity?: string,
  allowGooglePasscodeException?: boolean
) {
  return leases.transaction(async (tx) => {
    const [device] = await tx.$queryRaw<
      IPhoneDevice[]
    >`SELECT * FROM "IPhoneDevice" WHERE "userId"=${userId} FOR UPDATE`;
    if (device === undefined) throw new IPhoneError(404, 'iPhone device not found');
    const lease = await tx.iPhoneLease.findFirst({
      where: { deviceId: device.id, status: 'ACTIVE' },
    });
    if (lease !== null) await lockAgentWorkflowGeneration(tx, lease.agentId);
    await tx.$queryRaw`SELECT id FROM "User" WHERE "userId"=${userId} FOR SHARE`;
    if (!device.enabled || !(await leases.accountPermitted(tx, userId)))
      throw new IPhoneError(403, 'iPhone access denied');
    const physical = await tx.iPhoneOperation.findFirst({
      where: {
        deviceId: device.id,
        operation: { notIn: [...SETUP_OPERATIONS] },
        OR: [
          { activeDeviceId: { not: null } },
          { state: { in: ['CONNECTING', 'RUNNING'] } },
          {
            state: 'UNKNOWN',
            OR: [{ errorCode: null }, { errorCode: { not: 'provider_session_ended' } }],
          },
        ],
      },
      select: { id: true },
    });
    const attention =
      lease?.attentionRequestId !== null && lease?.attentionRequestId !== undefined
        ? await tx.agentAttentionRequest.findUnique({ where: { id: lease.attentionRequestId } })
        : null;
    if (
      physical !== null ||
      (attention?.userResponse === null && isNativePhoneAttention(attention.metadata))
    )
      throw new IPhoneError(409, 'Phone interaction is busy');
    const state = setupState(device.setupEncrypted);
    if (state.profileRevision !== expectedRevision)
      throw new IPhoneError(409, 'Phone setup profile changed');
    const allowed = profileExceptionAllowed(state, googleIdentity, allowGooglePasscodeException);
    const next = {
      version: 1 as const,
      profileRevision: state.profileRevision + 1,
      claimRevision: state.claimRevision,
      ...(allowed ? { allowGooglePasscodeException: true } : {}),
      expectedAppleIdentity: identity,
      ...((googleIdentity ?? state.expectedGoogleIdentity) !== undefined
        ? { expectedGoogleIdentity: googleIdentity ?? state.expectedGoogleIdentity }
        : {}),
      ...(state.expectedAppleIdentity === identity && state.verified
        ? { verified: { ...state.verified, profileRevision: state.profileRevision + 1 } }
        : {}),
      ...(state.verification ? { verification: state.verification } : {}),
      ...(state.passcodeCreation ? { passcodeCreation: state.passcodeCreation } : {}),
    };
    await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: { setupEncrypted: sealSetup(next), setupState: 'not_started' },
    });
    return {
      setup: {
        required: true,
        state: 'not_started',
        attemptId: null,
        revision: next.claimRevision,
        profileRevision: next.profileRevision,
      },
    };
  });
}

function profileExceptionAllowed(
  state: SetupState,
  googleIdentity: string | undefined,
  allow: boolean | undefined
) {
  const nextGoogleIdentity = googleIdentity ?? state.expectedGoogleIdentity;
  const same = nextGoogleIdentity === state.expectedGoogleIdentity;
  if (allow === true && (!same || nextGoogleIdentity === undefined || nextGoogleIdentity === ''))
    throw new IPhoneError(409, 'Configure Google identity before authorizing an exception');
  return same && (allow ?? state.allowGooglePasscodeException) === true;
}
