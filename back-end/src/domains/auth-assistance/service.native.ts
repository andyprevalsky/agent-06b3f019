import { notifyAuthAssistance } from '../../providers/smsSupervisor/outboundEvents';
import {
  getNativePhoneTarget,
  phoneMetadataObject,
  type NativePhoneInput,
} from '../../providers/nativePhoneAttention';
import * as repo from './repo.native';
import { findAgentForUser } from './repo';

export function presentNative(
  request: NonNullable<Awaited<ReturnType<typeof repo.nativeRequestById>>>
) {
  const metadata = phoneMetadataObject(request.attentionRequest.metadata);
  const target = getNativePhoneTarget(metadata);
  return {
    request: {
      id: request.id,
      agentId: request.agentId,
      userId: request.userId,
      authRealm: 'iphone',
      mode: 'manual_step',
      browserSessionId: null,
      steelSessionId: '',
      createdAt: request.createdAt.toISOString(),
      completedAt: request.completedAt?.toISOString() ?? null,
      target,
      criticalReason: metadata.criticalReason,
    },
    handoff: {
      type: 'manual_step',
      liveViewUrl: null,
      steelSessionId: null,
      target,
      criticalReason: metadata.criticalReason,
    },
  };
}
export async function createNative(userId: string, input: NativePhoneInput) {
  const result = await repo.createNativeRequest(userId, input);
  if (result.created) {
    // Transport mocks are mandatory in owning tests; no notification during retry.
    const agent = await findAgentForUser(input.agentId, userId);
    if (agent?.source === 'SMS')
      await notifyAuthAssistance(
        userId,
        { id: input.agentId },
        'iphone',
        input.browserTaskId,
        result.request.id
      );
  }
  return presentNative(result.request);
}
export async function readNative(id: string, userId: string, refresh = false) {
  const request = await repo.nativeRequestById(id, userId, refresh);
  if (request === null) return null;
  return {
    ...presentNative(request),
    ...(refresh ? { refreshed: false, alreadyCompleted: request.completedAt !== null } : {}),
  };
}
