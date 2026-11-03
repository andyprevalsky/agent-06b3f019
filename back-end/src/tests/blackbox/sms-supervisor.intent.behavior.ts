import type { PrismaClient } from '@prisma/client';

import { dispatchToolCall, type PendingOp } from '../../providers/smsSupervisor/supervisorTools';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  uniqueSmsPhone,
} from './sms-supervisor.helpers';

export async function testReplyToAgent_rejectsBareRejectionWithoutRequestId(prisma: PrismaClient) {
  const phone = uniqueSmsPhone();
  const userId = await provisionUserWithPhone(prisma, phone);
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Book the 7pm table at Bar Shoji',
      status: 'ACTIVE',
      source: 'SMS',
    },
  });
  const pendingWrites: PendingOp[] = [];

  try {
    // `reject: true` with no attention_request_id: the commit path would signal
    // the bare message, which `receive_user_response` reads as ordinary
    // feedback — silently turning a refusal into a comment and letting the
    // blocked tool proceed. Validation must refuse the combination outright.
    const result = await dispatchToolCall(
      {
        tool: 'reply_to_agent',
        arguments: {
          agent_id_or_prefix: agent.id.substring(0, 6),
          message: 'No, do not book that table.',
          reject: true,
        },
      },
      userId,
      pendingWrites
    );
    if (result.success || pendingWrites.length !== 0) {
      throw new Error(
        `Expected bare rejection to be refused, got ${JSON.stringify(result)} ` +
          `with ${pendingWrites.length} queued write(s)`
      );
    }
    if (!/attention_request_id/.test(result.error ?? '')) {
      throw new Error(`Expected an actionable error naming the missing id, got: ${result.error}`);
    }
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export function bareRejectionBlackboxCase(prisma: PrismaClient) {
  return {
    name: 'agent routing -- rejection without an attention request is refused',
    fn: () => testReplyToAgent_rejectsBareRejectionWithoutRequestId(prisma),
  };
}
