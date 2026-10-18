/** Atomic native attention publication, caller owns device and generation locks. */
import type { Prisma, IPhoneDevice, IPhoneLease, Agent } from '@prisma/client';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { privacyState } from '../../providers/phoneInputPrivacy';
import type { NativePhoneInput, NativePhoneTarget } from '../../providers/nativePhoneAttention';
export async function writeNativeRequest(
  tx: Prisma.TransactionClient,
  device: IPhoneDevice,
  current: { lease: IPhoneLease; agent: Agent },
  input: NativePhoneInput,
  id: string,
  inputHash: string,
  target: NativePhoneTarget,
  userId: string
) {
  const lease = current.lease;
  const context = {
    requestId: id,
    authRealm: 'iphone',
    mode: 'manual_step',
    target,
    criticalReason: input.criticalReason,
    requestKey: input.requestKey,
    expectedCursor: input.expectedCursor,
    inputHash,
    browserSessionId: null,
    steelSessionId: '',
    liveViewUrl: null,
  };
  const metadata = {
    attentionKind: 'auth_assistance',
    target,
    criticalReason: input.criticalReason,
    authAssistance: context,
    requestUserAuthentication: { ...context, handoffMode: 'manual_step' },
  };
  await tx.agentAttentionRequest.create({
    data: {
      id,
      userId,
      agentId: input.agentId,
      workflowId: current.agent.temporalWorkflowId ?? current.agent.id,
      question: 'Complete the protected step on your iPhone',
      metadata,
    },
  });
  const request = await tx.userAuthAssistanceRequest.create({
    data: {
      id,
      userId,
      agentId: input.agentId,
      authRealm: 'iphone',
      mode: 'manual_step',
      browserSessionId: null,
      steelSessionId: '',
    },
    include: { attentionRequest: true },
  });
  await tx.iPhoneLease.update({
    where: { id: lease.id },
    data: { attentionRequestId: id, controlOwner: 'user', revision: { increment: 1 } },
  });
  await tx.iPhoneDevice.update({
    where: { id: device.id },
    data: {
      privateInputEncrypted: sealPhoneValue({
        ...privacyState(device.privateInputEncrypted),
        active: true,
      }),
      ...(['in_progress', 'verifying'].includes(device.setupState)
        ? { setupState: 'awaiting_user' }
        : {}),
    },
  });

  return request;
}
