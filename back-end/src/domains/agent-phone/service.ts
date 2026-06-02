import { listInboundMessagesForNumber } from '../../providers/agentPhone';
import * as repo from './repo';
import type { AgentPhoneSmsMessage } from './types';

export async function fetchAgentPhoneMessagesSince(
  userId: string,
  since: Date,
  limit: number
): Promise<AgentPhoneSmsMessage[]> {
  const identity = await repo.findAgentIdentityForMessages(userId);
  const hasProviderNumber =
    identity?.phoneProviderNumberId !== null &&
    identity?.phoneProviderNumberId !== undefined &&
    identity.phoneProviderNumberId !== '';
  const hasPhone =
    identity?.phone !== null && identity?.phone !== undefined && identity.phone !== '';
  if (identity?.phoneProvider !== 'agentphone' || (!hasProviderNumber && !hasPhone)) {
    return [];
  }

  const messages = await listInboundMessagesForNumber({
    numberId: identity.phoneProviderNumberId,
    phoneNumber: identity.phone,
    since,
    limit,
  });

  return messages.map((message) => ({
    ...message,
    credentialId: identity.phone ?? message.to,
    credentialPhone: identity.phone ?? message.to,
  }));
}
