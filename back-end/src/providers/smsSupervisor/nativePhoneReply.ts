/** SMS reply -> persisted native target -> secure view; no authored text or completion. */
import { prisma } from '../database';
import { getNativePhoneTarget, isNativePhoneAttention } from '../nativePhoneAttention';
import { getAgentUrl } from '../smsTemplates';
import type { ToolResult } from './supervisorTools';

/** Recheck at commit too: native attention may begin after a reply was queued. */
export async function nativePhoneReplyRefusal(
  userId: string,
  agentId: string,
  requestId?: string
): Promise<ToolResult | null> {
  const addressed = requestId
    ? await prisma.agentAttentionRequest.findFirst({
        where: { id: requestId, userId, agentId },
        select: { id: true, metadata: true },
      })
    : null;
  const attention =
    addressed && isNativePhoneAttention(addressed.metadata)
      ? addressed
      : await prisma.agentAttentionRequest.findFirst({
          where: {
            userId,
            agentId,
            userResponse: null,
            metadata: { path: ['target', 'kind'], equals: 'iphone' },
          },
          select: { id: true, metadata: true },
        });
  if (!attention) return null;
  const target = getNativePhoneTarget(attention.metadata);
  return {
    tool: 'reply_to_agent',
    success: false,
    result: '',
    error: `Use the secure phone view to enter private information or complete this step: ${getAgentUrl(agentId, target?.browserTaskId, attention.id)}`,
  };
}
