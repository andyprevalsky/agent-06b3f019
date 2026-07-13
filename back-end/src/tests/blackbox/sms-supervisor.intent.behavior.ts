import type { PrismaClient } from '@prisma/client';

import { dispatchToolCall, type PendingOp } from '../../providers/smsSupervisor/supervisorTools';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  uniqueSmsPhone,
} from './sms-supervisor.helpers';

export async function testReplyToAgent_rejectsUnrelatedCurrentSms(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Call Bar Shoji and ask about indoor walk-in seating',
      status: 'ACTIVE',
      source: 'SMS',
    },
  });
  const pendingWrites: PendingOp[] = [];

  try {
    const result = await dispatchToolCall(
      {
        tool: 'reply_to_agent',
        arguments: {
          agent_id_or_prefix: agent.id.substring(0, 6),
          message: 'Approved. Place the call to Bar Shoji now.',
        },
      },
      userId,
      pendingWrites,
      {
        currentUserMessage: 'I asked you a question. Where is your response?',
        visibleSessionHistory: ['Hello?', "I'm here. What do you need?"],
        pendingAttentionRequestIds: [],
      }
    );
    if (result.success || pendingWrites.length !== 0) {
      throw new Error(
        `Expected unrelated reply_to_agent to be rejected, got ${JSON.stringify(result)}`
      );
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export function replyIntentBlackboxCase(prisma: PrismaClient) {
  return {
    name: 'agent routing -- unrelated current SMS cannot reply to stale agent',
    fn: () => testReplyToAgent_rejectsUnrelatedCurrentSms(prisma),
  };
}
